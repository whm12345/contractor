const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ddbClient = new DynamoDBClient({});
const ddbDoc = DynamoDBDocumentClient.from(ddbClient);

/**
 * Lambda handler for API Gateway HTTP API (v2 payload format).
 * GET /invoices?supplier_id=xxx
 */
exports.query = async (event) => {
  // ── Extract & validate supplier_id ──────────────────────────────────
  const supplierId = event.queryStringParameters?.supplier_id;
  if (!supplierId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing required parameter: supplier_id" }),
    };
  }

  const tableName = process.env.TABLE_NAME;
  const pk = `INVOICE#${supplierId}`;

  // ── Query DynamoDB ──────────────────────────────────────────────────
  try {
    const result = await ddbDoc.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: true, // ascending by sk
      })
    );

    const items = result.Items ?? [];
    const invoices = items.filter((item) => item.entity === "INVOICE");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        supplier_id: supplierId,
        count: invoices.length,
        invoices,
      }),
    };
  } catch (err) {
    console.error("Query failed:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
        detail: err.message,
      }),
    };
  }
};
