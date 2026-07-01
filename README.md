# Campfire Invoice Query

公司管理后台对接 Campfire ERP 财务数据的练习项目。功能：按供应商 ID 查询其所有发票。

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

### 测试

```bash
curl "https://<your-api-url>/invoices?supplier_id=sup_001"
```

**带分页：**

```bash
curl "https://<your-api-url>/invoices?supplier_id=sup_001&limit=10"
# 用返回的 next_token 获取下一页
curl "https://<your-api-url>/invoices?supplier_id=sup_001&limit=10&next_token=<token>"
```

> **注意：** API 当前未配置认证，可公开访问。如需生产环境认证，可添加 Cognito JWT、API Key 或 Lambda Authorizer。

## 表结构设计

### 主键（PK / SK）

| 属性 | 类型 | 说明 |
|------|------|------|
| `pk` | String | 分区键。统一为 `SUPPLIER#<id>`（供应商信息和其所有发票共享同一个分区） |
| `sk` | String | 排序键。供应商：`DETAIL`；发票：`INVOICE#<invoice_id>` |

### GSI：InvoiceByIdGSI

| 属性 | 类型 | 说明 |
|------|------|------|
| `gsi1pk` | String | `INVOICE#<invoice_id>` |
| `gsi1sk` | String | `INVOICE#<supplier_id>` |

用于未来按发票 ID 单独查询（当前主要查询不需要 GSI）。

### 实体属性

**供应商 (entity = SUPPLIER)**

| 属性 | 类型 |
|------|------|
| `name` | 供应商名称 |
| `contact_email` | 邮箱 |
| `contact_phone` | 电话 |
| `tax_id` | 税号 |
| `created_at` | ISO 8601 创建时间 |

**发票 (entity = INVOICE)**

| 属性 | 类型 |
|------|------|
| `invoice_id` | 发票 ID（UUID） |
| `supplier_id` | 关联供应商 ID |
| `amount` | 金额（Number） |
| `currency` | 币种（如 CNY、USD） |
| `date` | 发票日期（ISO 8601 格式 `YYYY-MM-DD`） |
| `status` | 状态：PENDING / PAID / OVERDUE |
| `description` | 描述 |
| `created_at` | ISO 8601 创建时间 |

## Seed 数据（手动插入示例）

部署后可通过 AWS CLI 手动插入：

```bash
# 供应商（pk 与发票共享 SUPPLIER#<id>，sk = DETAIL 区分）
aws dynamodb put-item --table-name CampfireInvoices --item '{
  "pk": {"S": "SUPPLIER#sup_001"},
  "sk": {"S": "DETAIL"},
  "entity": {"S": "SUPPLIER"},
  "name": {"S": "Campfire Tech Ltd."},
  "contact_email": {"S": "billing@campfire.co"},
  "contact_phone": {"S": "+1-555-0101"},
  "tax_id": {"S": "12-3456789"},
  "created_at": {"S": "2025-01-15T10:00:00Z"}
}'

# 发票（pk 与供应商一致，sk 前缀区分）
aws dynamodb put-item --table-name CampfireInvoices --item '{
  "pk": {"S": "SUPPLIER#sup_001"},
  "sk": {"S": "INVOICE#inv_001"},
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

重复上述模式插入 3 个供应商 + 7 张发票。

## 关键设计选择及理由

### 1. 单表设计

**选择**：所有数据存一个 DynamoDB 表，pk 统一为 `SUPPLIER#<id>`，sk 用前缀区分实体类型。

**理由**：
- 发票始终关联供应商，查询模式单一（只按 supplier_id 查），不需要跨表 JOIN
- 减少 DynamoDB 表数量，降低管理成本和 IAM 策略复杂度
- **同一 pk 下存储供应商信息和该供应商的全部发票**，一次 Query 即可读取完整数据
- sk 格式：`DETAIL`（供应商详情）、`INVOICE#<uuid>`（发票），查询时用 `begins_with(sk, "INVOICE#")` 过滤

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
                          │ GET /invoices?supplier_id=xxx
                   ┌──────▼───────┐
                   │   Lambda     │  并发上限500, 自动追踪
                   │  查询函数     │
                   └──────┬───────┘
                          │ DynamoDB Query
                   ┌──────▼───────┐
                   │  Campfire    │  单表设计, 加密, 删除保护
                   │  Invoices    │
                   └──────────────┘
                          │ 失败时
                   ┌──────▼───────┐
                   │   SQS DLQ    │  保留14天
                   └──────────────┘
```

### 关键资源

| 资源 | 说明 |
|------|------|
| `InvoiceHttpApi` | HTTP API (ApiGateway V2)，开启 CORS（允许 `*` 来源，GET + OPTIONS），限流 5000 req/s 突发 1000 |
| `InvoiceFunction` | Lambda，nodejs20.x，256MB，保留并发 500，失败投递到 SQS DLQ，开启 X-Ray 主动追踪 |
| `InvoiceTable` | DynamoDB 表，启用 SSE 加密和删除保护，PAY_PER_REQUEST 计费 |
| `InvoiceApiLogs` | API Gateway 访问日志，SSE 格式，保留 30 天 |
| `InvoiceDLQ` | SQS 死信队列，消息保留 14 天 |

### 监控告警（全部通过 SNS 分发）

| 告警 | 指标 | 阈值 | 周期 |
|------|------|------|------|
| Lambda 错误 | `Errors` | > 0 | 1 分钟 |
| Lambda 限流 | `Throttles` | > 0 | 1 分钟 |
| Lambda P99 延迟 | `Duration` (p99) | > 5s | 5 分钟 |
| API 5xx 错误 | `5XXError` | > 0 | 1 分钟 |
| DynamoDB 限流 | `SystemThrottlingCheckFailure` | > 0 | 1 分钟 |
| DLQ 积压 | `ApproximateNumberOfMessagesVisible` | > 0 | 5 分钟 |

所有告警动作指向同一 SNS Topic `CampfireInvoiceAlerts`，可绑定邮件/Slack/Webhook 等订阅。
