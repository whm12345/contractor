const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

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
 * Structured JSON logger. Writes to stdout (INFO) or stderr (WARN/ERROR)
 * based on the supplied level.
 */
function structuredLog(level, message, meta = {}) {
  const logFn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.info;
  logFn(
    JSON.stringify({
      level,
      service: "CampfireInvoiceQuery",
      timestamp: new Date().toISOString(),
      message,
      ...meta,
    })
  );
}

// ── Health check ────────────────────────────────────────────────────────
function handleHealthCheck() {
  if (DEBUG) structuredLog("INFO", "Health check called");
  return json(200, { status: "healthy", timestamp: new Date().toISOString() });
}

// ── GET /suppliers/:supplier_id — Get supplier detail ──────────────────
async function handleGetSupplier(event) {
  const supplierId = event.pathParameters?.supplier_id;
  if (!supplierId) {
    return json(400, { error: "Missing required parameter: supplier_id" });
  }

  const sanitizedId = supplierId.trim();
  if (!sanitizedId) {
    return json(400, { error: "supplier_id must not be empty" });
  }

  const tableName = process.env.SUPPLIER_TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  const pk = `SUPPLIER#${sanitizedId}`;

  try {
    const result = await ddbDoc.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
      })
    );

    const items = result.Items ?? [];
    const detail = items.find(i => i.sk === "DETAIL");
    const invoices = items.filter(i => i.sk.startsWith("INVOICE#"));

    if (DEBUG) {
      structuredLog("INFO", "Supplier detail queried", {
        supplierId: sanitizedId,
        invoiceCount: invoices.length,
        requestId: event.requestContext?.requestId,
      });
    }

    if (!detail) {
      return json(404, { error: `Supplier '${sanitizedId}' not found` });
    }

    return json(200, {
      ...detail,
      invoice_count: invoices.length,
      invoices: invoices.map(({ pk: _, sk: __, ...rest }) => rest),
    });
  } catch (err) {
    return handleDynamoError(err, "DynamoDB query failed", tableName, event);
  }
}

// ── PUT /suppliers — Upsert supplier detail ────────────────────────────
async function handleUpsertSupplier(event) {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON in request body" });
  }

  const supplierId = String(body.supplier_id ?? "").trim();
  if (!supplierId) {
    return json(400, { error: "Missing required field: supplier_id" });
  }
  if (Buffer.byteLength(supplierId) > 360) {
    return json(400, { error: "supplier_id exceeds maximum byte length (360)" });
  }

  const requiredFields = ["name", "contact_email"];
  for (const field of requiredFields) {
    if (!body[field] || String(body[field]).trim() === "") {
      return json(400, { error: `Missing required field: ${field}` });
    }
  }

  const tableName = process.env.SUPPLIER_TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  const pk = `SUPPLIER#${supplierId}`;
  const now = new Date().toISOString();

  const item = {
    pk,
    sk: "DETAIL",
    entity: "SUPPLIER",
    supplier_id: supplierId,
    name: String(body.name).trim(),
    contact_email: String(body.contact_email).trim(),
    updated_at: now,
  };
  if (body.contact_phone) item.contact_phone = String(body.contact_phone).trim();
  if (body.tax_id) item.tax_id = String(body.tax_id).trim();
  if (body.created_at) item.created_at = body.created_at;

  try {
    const result = await ddbDoc.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        ReturnValues: "ALL_NEW",
      })
    );

    if (DEBUG) {
      structuredLog("INFO", "Supplier created", { supplierId, requestId: event.requestContext?.requestId });
    }

    return json(201, result.Attributes);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Update existing supplier
      try {
        const sets = [];
        const vals = { ":name": item.name, ":email": item.contact_email, ":updated": now };
        const names = { "#name": "name", "#email": "contact_email", "#updated": "updated_at" };
        if (item.contact_phone !== undefined) {
          sets.push("#phone = :phone");
          vals[":phone"] = item.contact_phone;
          names["#phone"] = "contact_phone";
        }
        if (item.tax_id !== undefined) {
          sets.push("#tax = :tax");
          vals[":tax"] = item.tax_id;
          names["#tax"] = "tax_id";
        }
        const result = await ddbDoc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk, sk: "DETAIL" },
            UpdateExpression: `SET ${sets.concat(["#name = :name", "#email = :email", "#updated = :updated"]).join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: vals,
            ReturnValues: "ALL_NEW",
          })
        );
        if (DEBUG) {
          structuredLog("INFO", "Supplier updated", { supplierId, requestId: event.requestContext?.requestId });
        }
        return json(200, result.Attributes);
      } catch (updateErr) {
        return handleDynamoError(updateErr, "DynamoDB update failed", tableName, event);
      }
    }
    return handleDynamoError(err, "DynamoDB put failed", tableName, event);
  }
}

// ── GET /invoices — Query invoices by supplier ─────────────────────────
async function handleQueryInvoices(event) {
  // Extract & validate supplier_id
  const supplierId = event.queryStringParameters?.supplier_id;
  if (!supplierId) {
    return json(400, { error: "Missing required parameter: supplier_id" });
  }

  const sanitizedId = supplierId.trim();
  if (!sanitizedId) {
    return json(400, { error: "supplier_id must not be empty" });
  }
  if (Buffer.byteLength(sanitizedId) > 360) {
    return json(400, { error: "supplier_id exceeds maximum byte length (360)" });
  }

  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  const pk = `SUPPLIER#${sanitizedId}`;

  // Extract pagination parameters
  const rawLimit = parseInt(event.queryStringParameters?.limit);
  if (event.queryStringParameters?.limit !== undefined && (isNaN(rawLimit) || rawLimit < 1 || rawLimit > 1000)) {
    return json(400, { error: "limit must be an integer between 1 and 1000" });
  }
  const limit = event.queryStringParameters?.limit !== undefined ? rawLimit : 100;

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

  // Query DynamoDB
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

    const nextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
      : undefined;

    if (DEBUG) {
      structuredLog("INFO", "Query succeeded", {
        supplierId: sanitizedId,
        limit,
        count: invoices.length,
        hasMore: !!nextToken,
        requestId: event.requestContext?.requestId,
      });
    }

    return json(200, {
      supplier_id: sanitizedId,
      count: invoices.length,
      invoices,
      ...(nextToken && { next_token: nextToken }),
    });
  } catch (err) {
    return handleDynamoError(err, "DynamoDB query failed", tableName, event);
  }
}

// ── POST /invoices — Create a new invoice ──────────────────────────────
async function handleCreateInvoice(event) {
  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON in request body" });
  }

  // Validate required fields
  const requiredFields = ["supplier_id", "invoice_id", "amount", "currency", "date", "status", "description"];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return json(400, { error: `Missing required field: ${field}` });
    }
  }

  // Validate supplier_id
  const supplierId = String(body.supplier_id).trim();
  if (!supplierId) {
    return json(400, { error: "supplier_id must not be empty" });
  }
  if (Buffer.byteLength(supplierId) > 360) {
    return json(400, { error: "supplier_id exceeds maximum byte length (360)" });
  }

  // Validate invoice_id
  const invoiceId = String(body.invoice_id).trim();
  if (!invoiceId) {
    return json(400, { error: "invoice_id must not be empty" });
  }
  if (Buffer.byteLength(invoiceId) > 360) {
    return json(400, { error: "invoice_id exceeds maximum byte length (360)" });
  }

  // Validate amount
  const rawAmount = Number(body.amount);
  if (isNaN(rawAmount) || rawAmount <= 0) {
    return json(400, { error: "amount must be a positive number" });
  }

  // Round to 2 decimal places (avoid floating-point precision issues)
  const amount = Number(rawAmount.toFixed(2));
  if (amount <= 0) {
    return json(400, { error: "amount is too small, minimum is 0.01" });
  }

  // Validate currency
  const currency = String(body.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return json(400, { error: "currency must be a valid 3-letter ISO code (e.g., USD, CNY)" });
  }

  // Validate date (YYYY-MM-DD)
  const date = String(body.date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(400, { error: "date must be in YYYY-MM-DD format" });
  }

  // Validate status
  const validStatuses = ["PENDING", "PAID", "OVERDUE"];
  const status = String(body.status).trim().toUpperCase();
  if (!validStatuses.includes(status)) {
    return json(400, { error: `status must be one of: ${validStatuses.join(", ")}` });
  }

  // Validate description
  const description = String(body.description).trim();
  if (!description) {
    return json(400, { error: "description must not be empty" });
  }

  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  const now = new Date().toISOString();
  const item = {
    pk: `SUPPLIER#${supplierId}`,
    sk: `INVOICE#${invoiceId}`,
    gsi1pk: `INVOICE#${invoiceId}`,
    gsi1sk: `INVOICE#${supplierId}`,
    entity: "INVOICE",
    supplier_id: supplierId,
    invoice_id: invoiceId,
    amount: amount,
    currency: currency,
    date: date,
    status: status,
    description: description,
    created_at: now,
  };

  try {
    await ddbDoc.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      })
    );

    if (DEBUG) {
      structuredLog("INFO", "Invoice created", {
        supplierId,
        invoiceId,
        requestId: event.requestContext?.requestId,
      });
    }

    return json(201, item);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(409, {
        error: `Invoice '${invoiceId}' already exists for supplier '${supplierId}'`,
      });
    }
    return handleDynamoError(err, "DynamoDB put failed", tableName, event);
  }
}

// ── PUT /invoices — Update an existing invoice ─────────────────────────
async function handleUpdateInvoice(event) {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON in request body" });
  }

  // Validate required identifying fields
  const requiredFields = ["supplier_id", "invoice_id"];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return json(400, { error: `Missing required field: ${field}` });
    }
  }

  const supplierId = String(body.supplier_id).trim();
  if (!supplierId) {
    return json(400, { error: "supplier_id must not be empty" });
  }
  if (Buffer.byteLength(supplierId) > 360) {
    return json(400, { error: "supplier_id exceeds maximum byte length (360)" });
  }

  const invoiceId = String(body.invoice_id).trim();
  if (!invoiceId) {
    return json(400, { error: "invoice_id must not be empty" });
  }
  if (Buffer.byteLength(invoiceId) > 360) {
    return json(400, { error: "invoice_id exceeds maximum byte length (360)" });
  }

  // Collect fields to update
  const updatableFields = ["amount", "currency", "date", "status", "description"];
  const updates = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  for (const field of updatableFields) {
    if (body[field] === undefined || body[field] === null) continue;

    const raw = String(body[field]).trim();
    if (raw === "") {
      return json(400, { error: `${field} must not be empty` });
    }

    switch (field) {
      case "amount": {
        const rawAmount = Number(body[field]);
        if (isNaN(rawAmount) || rawAmount <= 0) {
          return json(400, { error: "amount must be a positive number" });
        }
        const val = Number(rawAmount.toFixed(2));
        if (val <= 0) {
          return json(400, { error: "amount is too small, minimum is 0.01" });
        }
        updates.push("#amount = :amount");
        expressionAttributeValues[":amount"] = val;
        expressionAttributeNames["#amount"] = "amount";
        break;
      }
      case "currency": {
        const val = raw.toUpperCase();
        if (!/^[A-Z]{3}$/.test(val)) {
          return json(400, { error: "currency must be a valid 3-letter ISO code (e.g., USD, CNY)" });
        }
        updates.push("#currency = :currency");
        expressionAttributeValues[":currency"] = val;
        expressionAttributeNames["#currency"] = "currency";
        break;
      }
      case "date": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          return json(400, { error: "date must be in YYYY-MM-DD format" });
        }
        updates.push("#date = :date");
        expressionAttributeValues[":date"] = raw;
        expressionAttributeNames["#date"] = "date";
        break;
      }
      case "status": {
        const validStatuses = ["PENDING", "PAID", "OVERDUE"];
        const val = raw.toUpperCase();
        if (!validStatuses.includes(val)) {
          return json(400, { error: `status must be one of: ${validStatuses.join(", ")}` });
        }
        updates.push("#status = :status");
        expressionAttributeValues[":status"] = val;
        expressionAttributeNames["#status"] = "status";
        break;
      }
      case "description": {
        updates.push("#description = :description");
        expressionAttributeValues[":description"] = raw;
        expressionAttributeNames["#description"] = "description";
        break;
      }
    }
  }

  if (updates.length === 0) {
    return json(400, { error: "No fields to update. Provide at least one of: amount, currency, date, status, description" });
  }

  // Always bump updated_at
  updates.push("#updated_at = :updated_at");
  expressionAttributeValues[":updated_at"] = new Date().toISOString();
  expressionAttributeNames["#updated_at"] = "updated_at";

  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  try {
    const result = await ddbDoc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `SUPPLIER#${supplierId}`,
          sk: `INVOICE#${invoiceId}`,
        },
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: expressionAttributeNames,
        ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
        ReturnValues: "ALL_NEW",
      })
    );

    if (DEBUG) {
      structuredLog("INFO", "Invoice updated", {
        supplierId,
        invoiceId,
        fields: Object.keys(expressionAttributeNames).map((k) => k.replace("#", "")).filter((f) => f !== "updated_at"),
        requestId: event.requestContext?.requestId,
      });
    }

    return json(200, result.Attributes);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(404, {
        error: `Invoice '${invoiceId}' not found for supplier '${supplierId}'`,
      });
    }
    return handleDynamoError(err, "DynamoDB update failed", tableName, event);
  }
}

// ── DELETE /invoices — Delete an invoice ───────────────────────────────
async function handleDeleteInvoice(event) {
  const supplierId = event.queryStringParameters?.supplier_id;
  if (!supplierId) {
    return json(400, { error: "Missing required parameter: supplier_id" });
  }

  const sanitizedSupplierId = supplierId.trim();
  if (!sanitizedSupplierId) {
    return json(400, { error: "supplier_id must not be empty" });
  }
  if (Buffer.byteLength(sanitizedSupplierId) > 360) {
    return json(400, { error: "supplier_id exceeds maximum byte length (360)" });
  }

  const invoiceId = event.queryStringParameters?.invoice_id;
  if (!invoiceId) {
    return json(400, { error: "Missing required parameter: invoice_id" });
  }

  const sanitizedInvoiceId = invoiceId.trim();
  if (!sanitizedInvoiceId) {
    return json(400, { error: "invoice_id must not be empty" });
  }
  if (Buffer.byteLength(sanitizedInvoiceId) > 360) {
    return json(400, { error: "invoice_id exceeds maximum byte length (360)" });
  }

  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    return json(500, { error: "Internal server error" });
  }

  try {
    await ddbDoc.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `SUPPLIER#${sanitizedSupplierId}`,
          sk: `INVOICE#${sanitizedInvoiceId}`,
        },
        ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
      })
    );

    if (DEBUG) {
      structuredLog("INFO", "Invoice deleted", {
        supplierId: sanitizedSupplierId,
        invoiceId: sanitizedInvoiceId,
        requestId: event.requestContext?.requestId,
      });
    }

    return json(200, { message: "Invoice deleted", supplier_id: sanitizedSupplierId, invoice_id: sanitizedInvoiceId });
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(404, {
        error: `Invoice '${sanitizedInvoiceId}' not found for supplier '${sanitizedSupplierId}'`,
      });
    }
    return handleDynamoError(err, "DynamoDB delete failed", tableName, event);
  }
}

// ── Shared DynamoDB error handler ───────────────────────────────────────
function handleDynamoError(err, logMessage, tableName, event) {
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

  structuredLog("ERROR", logMessage, {
    error: err.name,
    message: err.message,
    correlationId: event.requestContext?.requestId,
    ...(DEBUG && { stack: err.stack }),
  });
  return json(500, {
    error: "Internal server error",
    ...(DEBUG && { detail: err.message }),
  });
}

// ── Main router ─────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath;

  // Health check
  if (path === "/health") {
    return handleHealthCheck();
  }

  // Invoice routes
  if (path === "/invoices") {
    if (method === "GET") {
      return handleQueryInvoices(event);
    }
    if (method === "POST") {
      return handleCreateInvoice(event);
    }
    if (method === "PUT") {
      return handleUpdateInvoice(event);
    }
    if (method === "DELETE") {
      return handleDeleteInvoice(event);
    }
  }

  // Supplier routes
  if (path === "/suppliers" && method === "POST") {
    return handleUpsertSupplier(event);
  }

  if (method === "GET" && /^\/suppliers\/[^\/]+$/.test(path)) {
    const supplierId = event.pathParameters?.supplier_id;
    if (supplierId) {
      return handleGetSupplier(event);
    }
  }

  return json(405, { error: "Method not allowed" });
};

// Legacy export for backward compatibility
exports.query = handleQueryInvoices;
