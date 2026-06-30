const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ddbClient = new DynamoDBClient({});
const ddbDoc = DynamoDBDocumentClient.from(ddbClient);

const DEBUG = process.env.DEBUG === "1";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

/**
 * Build a standardized JSON response for API Gateway HTTP API v2.
 */
function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

/**
 * Lambda handler for API Gateway HTTP API (v2 payload format).
 * GET /invoices?supplier_id=xxx&limit=100&next_token=...
 */
exports.query = async (event) => {
  // ── Health check ────────────────────────────────────────────────────
  if (event.rawPath === "/health" || event.rawPath === "/healthz") {
    return json(200, { status: "healthy", timestamp: new Date().toISOString() });
  }

  // ── Extract & validate supplier_id ──────────────────────────────────
  const supplierId = event.queryStringParameters?.supplier_id;
  if (!supplierId) {
    return json(400, { error: "Missing required parameter: supplier_id" });
  }

  // Trim whitespace and enforce DynamoDB 400-byte string limit (use UTF-8 byte length for multi-byte chars)
  const sanitizedId = supplierId.trim();
  if (Buffer.byteLength(sanitizedId) > 360) {
    // 400 byte limit minus "INVOICE#" prefix length
    return json(400, { error: "supplier_id exceeds maximum length (360 chars)" });
  }

  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  const pk = `INVOICE#${sanitizedId}`;

  // ── Extract pagination parameters ───────────────────────────────────
  const rawLimit = parseInt(event.queryStringParameters?.limit);
  if (isNaN(rawLimit) || rawLimit < 0 || rawLimit > 1000) {
    return json(400, { error: "limit must be an integer between 0 and 1000" });
  }
  const limit = rawLimit;

  let exclusiveStartKey;
  if (event.queryStringParameters?.next_token) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(event.queryStringParameters.next_token, "base64").toString("utf-8")
      );
    } catch (err) {
      return json(400, { error: "Invalid next_token: must be a valid base64-encoded DynamoDB key" });
    }
  }

  // ── Structured logging helper ─────────────────────────────────────────
  function structuredLog(level, message, meta = {}) {
    console.error(
      JSON.stringify({
        level,
        service: "CampfireInvoiceQuery",
        timestamp: new Date().toISOString(),
        message,
        ...meta,
      })
    );
  }

  // ── Query DynamoDB ──────────────────────────────────────────────────
  try {
    const result = await ddbDoc.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": "INVOICE#",
        },
        ScanIndexForward: true,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    const invoices = result.Items ?? [];

    // Build pagination token: encode the LastEvaluatedKey as base64
    const nextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
      : undefined;

    return json(200, {
      supplier_id: sanitizedId,
      count: invoices.length,
      invoices,
      ...(nextToken && { next_token: nextToken }),
    });
  } catch (err) {
    // ── Classify error type for correct HTTP status ───────────────────
    const isThrottle =
      err.name === "ThrottlingException" ||
      err.name === "ProvisionedThroughputExceededException" ||
      err.name === "RequestLimitExceeded";

    if (isThrottle) {
      structuredLog("WARN", "DynamoDB throttled", { error: err.name, retryDelay: err.retryDelay });
      const retryAfter = Math.ceil((err.retryDelay ?? 1000) / 1000);
      return json(429, { error: "Service busy, please retry", retry_after: retryAfter }, { "Retry-After": `${retryAfter}` });
    }

    if (err.name === "ResourceNotFoundException") {
      structuredLog("ERROR", "DynamoDB table not found", { tableName });
      return json(500, { error: "Database table not available" });
    }

    // General error
    structuredLog("ERROR", "DynamoDB query failed", { error: err.name, message: err.message, stack: err.stack, correlationId: event.requestContext?.requestId });
    return json(500, {
      error: "Internal server error",
      ...(DEBUG && { detail: err.message }),
    });
  }
};
