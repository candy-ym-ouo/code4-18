# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整和材料消耗支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建唯一操作员 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |

初始化请求：

```json
{
  "displayName": "工作室操作员",
  "password": "至少10位密码"
}
```

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| POST | `/materials/:id/archive` | 归档 |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| POST | `/attachment-integrity/reindex` | 全量重索引并扫描孤立文件 |
| GET | `/attachment-integrity/status` | 索引状态汇总与明细 |
| GET | `/attachment-integrity/issues` | 完整性问题列表 |
| GET | `/attachment-integrity/orphans` | 孤立文件列表 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。

## 10. 附件完整性索引

系统为每个附件维护独立的完整性索引，基线来自上传时写入的 `sha256`、`byte_size`、
`storage_key`、`owner_type`、`owner_id`，重索引只记录磁盘观测值，绝不回写或替换基线。

`POST /attachment-integrity/reindex` 执行一次全量扫描（已有扫描运行时返回
`409 REINDEX_ALREADY_RUNNING`），可重复执行、结果幂等：

1. 流式重新计算磁盘文件 sha256 与字节数，与基线比对；
2. 校验 `ownerType/ownerId` 指向的批次、颜色变化、项目或消耗记录仍然存在；
3. 递归扫描 `UPLOAD_DIR`，找出附件表未引用的孤立文件；
4. 刷新索引状态、追加/复现/解析问题记录，并写入一条运行汇总。

索引状态：

- `OK`：文件存在、哈希与大小一致且所有者存在；
- `MISSING`：磁盘文件缺失（`FILE_MISSING`，不修改基线）；
- `CONFLICT`：`HASH_MISMATCH`、`SIZE_MISMATCH` 或 `SIZE_AND_HASH_MISMATCH`，
  基线与实际观测同时保留，**不会自动替换任何一方**；
- `OWNER_DANGLING`：所有者记录不存在（引用悬挂）；
- `UNREADABLE`：文件存在但无法读取（`UNREADABLE_FILE`）。

问题严重程度：哈希不一致、大小与哈希同时不一致、文件不可读为 `CRITICAL`；
仅大小不一致和引用悬挂为 `WARNING`。

问题与孤立文件只增审计、状态化流转：本次扫描复现的问题更新 `lastSeenAt`；
未复现的 `OPEN` 问题标记为 `RESOLVED`（`resolveReason=NOT_REPRODUCED`）；
孤立文件被重新引用或消失后同样标记 `RESOLVED`，历史记录保留。

查询接口支持 `status`、`limit`（1–500，默认 100）等过滤参数；
`GET /attachment-integrity/status` 按状态返回计数、最近一次运行和索引明细。

运维侧可使用 CLI（`pnpm --filter @handcraft/api attachments:reindex`），
支持 `--json` 输出和 `--strict`（存在缺失、冲突、悬挂、不可读或孤立文件时退出码为 2），
适合接入定时任务与备份校验流水线。

