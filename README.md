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

## 表结构设计

### 主键（PK / SK）

| 属性 | 类型 | 说明 |
|------|------|------|
| `pk` | String | 分区键。供应商：`SUPPLIER#<id>`；发票：`INVOICE#<supplier_id>` |
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
# 供应商
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

# 发票（sup_001 的 3 张发票）
aws dynamodb put-item --table-name CampfireInvoices --item '{
  "pk": {"S": "INVOICE#sup_001"},
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

**选择**：所有数据存一个 DynamoDB 表，用 `pk` 前缀区分 `SUPPLIER#` 和 `INVOICE#`。

**理由**：
- 发票始终关联供应商，查询模式单一（只按 supplier_id 查），不需要跨表 JOIN
- 减少 DynamoDB 表数量，降低管理成本和 IAM 策略复杂度
- 同一 Partition 存储供应商信息和该供应商的全部发票，读取高效

### 2. 发票 SK 使用 `INVOICE#<invoice_id>` 而非日期

**选择**：Sort Key 为 `INVOICE#<uuid>`。

**理由**：
- 当前需求只需"列出供应商所有发票"，不需要按日期范围查询
- 保持 SK 简单，避免日期格式不一致导致的排序问题
- 如果未来需要日期范围查询，可改为 `2026-01-10#<uuid>` 前缀格式
