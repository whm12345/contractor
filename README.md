# Campfire Invoice Query

公司管理后台对接 Campfire ERP 财务数据的练习项目。提供供应商管理和发票的完整 CRUD 接口（查询、新增、修改、删除）。

## API 总览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/invoices?supplier_id=xxx` | 按供应商查询发票（支持分页） |
| `POST` | `/invoices` | 新增发票 |
| `PUT` | `/invoices` | 修改发票（部分字段更新） |
| `DELETE` | `/invoices?supplier_id=xxx&invoice_id=xxx` | 删除发票 |
| `POST` | `/suppliers` | 新增/更新供应商信息 |
| `GET` | `/suppliers/{supplier_id}` | 查询供应商详情（含发票列表） |
| `GET` | `/health` | 健康检查 |

> **CORS**：API Gateway 已全局配置 CORS，支持 `GET/POST/PUT/DELETE/OPTIONS` 方法，允许所有来源（`*`）。浏览器可直接跨域调用。

## 部署

```bash
# 1. 构建
sam build

# 2. 部署（首次运行加 --guided 会引导你输入栈名等参数）
sam deploy --guided

# 按提示输入：
# Stack Name: campfire-invoice-query
# AWS Region: ap-northeast-1  （或其他你的区域）
# Confirm changes: Y
```

部署成功后，`Outputs` 中会显示 API URL，形如：

```
https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod/invoices
```

### 查询发票

```bash
curl "https://<your-api-url>/invoices?supplier_id=sup_001"
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `supplier_id` | String | 是 | 供应商 ID |
| `limit` | Integer | 否 | 每页条数（1–1000，默认 100） |
| `next_token` | String | 否 | 分页令牌（由上次响应返回） |

**响应示例：**

```json
{
  "supplier_id": "sup_001",
  "count": 2,
  "invoices": [
    {
      "pk": "SUPPLIER#sup_001",
      "sk": "INVOICE#inv_001",
      "entity": "INVOICE",
      "supplier_id": "sup_001",
      "invoice_id": "inv_001",
      "amount": 2500.00,
      "currency": "USD",
      "date": "2026-01-10",
      "status": "PAID",
      "description": "Cloud infrastructure services",
      "created_at": "2026-01-10T10:00:00Z"
    }
  ],
  "next_token": "eyJwayI6IlNVUF..."
}
```

> `next_token` 仅在还有更多结果时出现。将其值原样传入下次请求即可获取下一页。

**带分页：**

```bash
curl "https://<your-api-url>/invoices?supplier_id=sup_001&limit=10"
# 用返回的 next_token 获取下一页
curl "https://<your-api-url>/invoices?supplier_id=sup_001&limit=10&next_token=<token>"
```

### 新增发票

```bash
curl -X POST "https://<your-api-url>/invoices" \
  -H "Content-Type: application/json" \
  -d '{
    "supplier_id": "sup_001",
    "invoice_id": "inv_004",
    "amount": 5000.00,
    "currency": "USD",
    "date": "2026-07-01",
    "status": "PENDING",
    "description": "Cloud infrastructure services - Q3"
  }'
```

**请求字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `supplier_id` | String | 是 | 供应商 ID |
| `invoice_id` | String | 是 | 发票 ID（唯一） |
| `amount` | Number | 是 | 金额（正数） |
| `currency` | String | 是 | 币种（3 位 ISO 代码，如 USD、CNY） |
| `date` | String | 是 | 发票日期（YYYY-MM-DD） |
| `status` | String | 是 | 状态：PENDING / PAID / OVERDUE |
| `description` | String | 是 | 描述 |

**错误码：**

| HTTP 状态码 | 说明 |
|--------------|------|
| 201 | 创建成功，返回完整的发票对象 |
| 400 | 缺少必填字段或字段格式不正确 |
| 409 | 发票 ID 已存在（不允许重复） |
| 429 | DynamoDB 限流，稍后重试 |
| 500 | 服务器内部错误 |

**响应示例（201）：**

```json
{
  "pk": "SUPPLIER#sup_001",
  "sk": "INVOICE#inv_004",
  "gsi1pk": "INVOICE#inv_004",
  "gsi1sk": "INVOICE#sup_001",
  "entity": "INVOICE",
  "supplier_id": "sup_001",
  "invoice_id": "inv_004",
  "amount": 5000.00,
  "currency": "USD",
  "date": "2026-07-01",
  "status": "PENDING",
  "description": "Cloud infrastructure services - Q3",
  "created_at": "2026-07-01T08:00:00.000Z"
}
```

### 修改发票

```bash
curl -X PUT "https://<your-api-url>/invoices" \
  -H "Content-Type: application/json" \
  -d '{
    "supplier_id": "sup_001",
    "invoice_id": "inv_004",
    "status": "PAID",
    "amount": 5500.00
  }'
```

`supplier_id` 和 `invoice_id` 为必填，其余字段按需提供（至少提供一个）。

**错误码：**

| HTTP 状态码 | 说明 |
|--------------|------|
| 200 | 修改成功，返回完整发票对象 |
| 400 | 缺少必填参数或字段格式不正确 |
| 404 | 发票不存在 |
| 429 | DynamoDB 限流，稍后重试 |
| 500 | 服务器内部错误 |

**响应示例（200）：**

```json
{
  "pk": "SUPPLIER#sup_001",
  "sk": "INVOICE#inv_004",
  "entity": "INVOICE",
  "supplier_id": "sup_001",
  "invoice_id": "inv_004",
  "amount": 5500.00,
  "currency": "USD",
  "date": "2026-07-01",
  "status": "PAID",
  "description": "Cloud infrastructure services - Q3",
  "created_at": "2026-07-01T08:00:00.000Z",
  "updated_at": "2026-07-02T10:30:00.000Z"
}
```

### 删除发票

```bash
curl -X DELETE "https://<your-api-url>/invoices?supplier_id=sup_001&invoice_id=inv_004"
```

**响应示例（200）：**

```json
{
  "message": "Invoice deleted",
  "supplier_id": "sup_001",
  "invoice_id": "inv_004"
}
```

**错误码：**

| HTTP 状态码 | 说明 |
|--------------|------|
| 200 | 删除成功 |
| 400 | 缺少必填参数或字段格式不正确 |
| 404 | 发票不存在 |
| 429 | DynamoDB 限流，稍后重试 |
| 500 | 服务器内部错误 |

### 新增/更新供应商

```bash
curl -X POST "https://<your-api-url>/suppliers" \
  -H "Content-Type: application/json" \
  -d '{
    "supplier_id": "sup_001",
    "name": "Campfire Tech Ltd.",
    "contact_email": "billing@campfire.co",
    "contact_phone": "+1-555-0101",
    "tax_id": "12-3456789"
  }'
```

**请求字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `supplier_id` | String | 是 | 供应商 ID |
| `name` | String | 是 | 供应商名称 |
| `contact_email` | String | 是 | 联系邮箱 |
| `contact_phone` | String | 否 | 联系电话 |
| `tax_id` | String | 否 | 税号 |

> 如果该 `supplier_id` 已存在，则执行更新操作（PUT 语义）。

**错误码：**

| HTTP 状态码 | 说明 |
|--------------|------|
| 201 | 创建成功 |
| 200 | 更新成功 |
| 400 | 缺少必填字段或字段格式不正确 |
| 500 | 服务器内部错误 |

### 查询供应商详情

```bash
curl "https://<your-api-url>/suppliers/sup_001"
```

**响应示例（200）：**

```json
{
  "pk": "SUPPLIER#sup_001",
  "sk": "DETAIL",
  "entity": "SUPPLIER",
  "supplier_id": "sup_001",
  "name": "Campfire Tech Ltd.",
  "contact_email": "billing@campfire.co",
  "contact_phone": "+1-555-0101",
  "tax_id": "12-3456789",
  "created_at": "2025-01-15T10:00:00Z",
  "updated_at": "2026-07-01T08:00:00Z",
  "invoice_count": 3,
  "invoices": [
    {
      "invoice_id": "inv_001",
      "amount": 2500.00,
      "currency": "USD",
      "date": "2026-01-10",
      "status": "PAID",
      "description": "Cloud infrastructure services",
      "created_at": "2026-01-10T10:00:00Z"
    }
  ]
}
```

> `invoices` 数组仅包含发票的核心字段（不含 `pk`、`sk`、`gsi1pk`、`gsi1sk` 等内部属性）。

**错误码：**

| HTTP 状态码 | 说明 |
|--------------|------|
| 200 | 查询成功 |
| 400 | 缺少 supplier_id 参数 |
| 404 | 供应商不存在 |
| 500 | 服务器内部错误 |

### 健康检查

```bash
curl "https://<your-api-url>/health"
```

**响应示例（200）：**

```json
{
  "status": "healthy",
  "timestamp": "2026-07-01T08:00:00.000Z"
}
```

> **注意：** API 当前未配置认证，可公开访问。如需生产环境认证，可添加 Cognito JWT、API Key 或 Lambda Authorizer。

### 表结构设计

#### DynamoDB 主键

| 属性 | 类型 | 说明 |
|------|------|------|
| `pk` | String | 分区键，格式 `SUPPLIER#<id>`，将同一供应商的详情和所有发票组织在同一个分区下 |
| `sk` | String | 排序键：`DETAIL`（供应商详情）/ `INVOICE#<invoice_id>`（发票） |

#### GSI：InvoiceByIdGSI

| 属性 | 类型 | 说明 |
|------|------|------|
| `gsi1pk` | String | `INVOICE#<invoice_id>` |
| `gsi1sk` | String | `INVOICE#<supplier_id>` |

预留按发票 ID 单独查询能力，当前主要查询不需要此 GSI。

#### 供应商实体属性（sk = DETAIL）

| 属性 | 类型 | 说明 |
|------|------|------|
| `entity` | String | 固定为 `SUPPLIER` |
| `supplier_id` | String | 供应商 ID |
| `name` | String | 供应商名称 |
| `contact_email` | String | 联系邮箱 |
| `contact_phone` | String | 联系电话（可选） |
| `tax_id` | String | 税号（可选） |
| `created_at` | String | ISO 8601 创建时间 |
| `updated_at` | String | ISO 8601 最后更新时间 |

#### 发票实体属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `entity` | String | 固定为 `INVOICE` |
| `supplier_id` | String | 关联供应商 ID |
| `invoice_id` | String | 发票 ID |
| `amount` | Number | 金额 |
| `currency` | String | 币种（如 CNY、USD） |
| `date` | String | 发票日期（`YYYY-MM-DD`） |
| `status` | String | 状态：PENDING / PAID / OVERDUE |
| `description` | String | 描述 |
| `created_at` | String | ISO 8601 创建时间 |
| `updated_at` | String | ISO 8601 最后修改时间（PUT 操作自动写入） |

## Seed 数据（手动插入示例）

部署后可通过 AWS CLI 手动插入：

```bash
# 供应商详情
aws dynamodb put-item --table-name CampfireInvoices --item '{
  "pk": {"S": "SUPPLIER#sup_001"},
  "sk": {"S": "DETAIL"},
  "entity": {"S": "SUPPLIER"},
  "supplier_id": {"S": "sup_001"},
  "name": {"S": "Campfire Tech Ltd."},
  "contact_email": {"S": "billing@campfire.co"},
  "contact_phone": {"S": "+1-555-0101"},
  "tax_id": {"S": "12-3456789"},
  "created_at": {"S": "2025-01-15T10:00:00Z"},
  "updated_at": {"S": "2025-01-15T10:00:00Z"}
}'

# 发票
aws dynamodb put-item --table-name CampfireInvoices --item '{
  "pk": {"S": "SUPPLIER#sup_001"},
  "sk": {"S": "INVOICE#inv_001"},
  "gsi1pk": {"S": "INVOICE#inv_001"},
  "gsi1sk": {"S": "INVOICE#sup_001"},
  "entity": {"S": "INVOICE"},
  "supplier_id": {"S": "sup_001"},
  "invoice_id": {"S": "inv_001"},
  "amount": {"N": "2500.00"},
  "currency": {"S": "USD"},
  "date": {"S": "2026-01-10"},
  "status": {"S": "PAID"},
  "description": {"S": "Cloud infrastructure services"},
  "created_at": {"S": "2026-01-10T10:00:00Z"}
}'
```

重复上述模式插入多个供应商及其发票。每个供应商（`pk`）下包含一条 `sk=DETAIL` 的详情记录和若干发票记录。

## 关键设计选择及理由

### 1. 单表设计

**选择**：所有数据存一个 DynamoDB 表，pk 统一为 `SUPPLIER#<id>`，sk 用前缀区分实体类型。

**理由**：
- 发票和供应商详情始终关联，查询模式单一（按 supplier_id 查），不需要跨表 JOIN
- 减少 DynamoDB 表数量，降低管理成本和 IAM 策略复杂度
- **同一 pk 下存储供应商详情和该供应商的全部发票**，一次 Query 即可读取完整数据
- sk 格式：`DETAIL`（供应商详情）、`INVOICE#<uuid>`（发票），查询时用 `begins_with(sk, "INVOICE#")` 过滤发票

### 2. 发票 SK 使用 `INVOICE#<invoice_id>` 而非日期

**选择**：Sort Key 为 `INVOICE#<uuid>`。

**理由**：
- 当前需求只需"列出供应商所有发票"，不需要按日期范围查询
- 保持 SK 简单，避免日期格式不一致导致的排序问题
- 如果未来需要日期范围查询，可改为 `2026-01-10#<uuid>` 前缀格式

## 部署架构

### 整体拓扑

```
                   ┌──────────────┐
        user ──►   │  HTTP API    │
                   │  (CORS+限流)  │
                   └──────┬───────┘
                          │ GET/POST/PUT/DELETE /invoices
                          │ POST /suppliers
                          │ GET /suppliers/{supplier_id}
                   ┌──────▼───────┐
                   │   Lambda     │  并发上限500, 自动追踪
                   │  CRUD 函数   │
                   └──────┬───────┘
                          │ DynamoDB Query
                   ┌──────▼───────┐
                   │  Campfire    │  单表设计, 加密, 删除保护
                   │  Invoices    │
                   └──────────────┘
                          │ 未来异步事件源失败时
                   ┌──────▼───────┐
                   │   SQS DLQ    │  保留14天（异步事件预留）
                   └──────────────┘
```

### 关键资源

| 资源 | 说明 |
|------|------|
| `InvoiceHttpApi` | HTTP API (ApiGateway V2)，开启 CORS（允许 `*` 来源，GET/POST/PUT/DELETE/OPTIONS），限流 5000 req/s 突发 1000 |
| `InvoiceFunction` | Lambda，nodejs20.x，256MB，保留并发 500，开启 X-Ray 主动追踪。由 API Gateway 同步调用，提供发票和供应商 CRUD |
| `InvoiceTable` | DynamoDB 表，启用 SSE 加密和删除保护，PAY_PER_REQUEST 计费 |
| `InvoiceApiLogs` | API Gateway 访问日志，SSE 格式，保留 30 天 |
| `InvoiceDLQ` | SQS 死信队列（为未来异步事件源预留），消息保留 14 天 |

### 监控告警（全部通过 SNS 分发）

| 告警 | 指标 | 阈值 | 周期 |
|------|------|------|------|
| Lambda 错误 | `Errors` | > 0 | 1 分钟 |
| Lambda 限流 | `Throttles` | > 0 | 1 分钟 |
| Lambda P99 延迟 | `Duration` (p99) | > 5s | 5 分钟 |
| API 5xx 错误 | `5xx` | > 0 | 1 分钟 |
| DynamoDB 限流 | `ThrottledRequests` | > 0 | 1 分钟 |
| DLQ 积压 | `ApproximateNumberOfMessagesVisible` | > 0 | 5 分钟 |

所有告警动作指向同一 SNS Topic `CampfireInvoiceAlerts`，可绑定邮件/Slack/Webhook 等订阅。
