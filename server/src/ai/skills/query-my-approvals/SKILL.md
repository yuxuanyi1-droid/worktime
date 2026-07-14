---
name: query-my-approvals
description: 查询待当前用户审批的事项，以及当前用户提交的审批进度
invocation:
  - 用户问"待审批""待我审批""审批任务""我的审批""审批进度""我提交的审批到哪了"
---

# 查询审批

查询**待当前用户审批**的任务，以及**当前用户提交**的审批进度。

## 认证

请求带 `Authorization: Bearer $WORKTIME_PAT`，base 地址 `$WORKTIME_API`。

## 接口

### 1. 待我审批

```
GET $WORKTIME_API/approvals/pending
```

返回所有待当前用户处理的审批任务（工时/加班/周报）。

### 2. 我提交的审批

```
GET $WORKTIME_API/approvals/my-submissions
```

| 参数 | 说明 | 示例 |
|---|---|---|
| `status` | `pending` / `approved` / `rejected` / `withdrawn` | `pending` |
| `page` / `pageSize` | 分页 | `1` / `20` |

### 3. 审批历史（已处理）

```
GET $WORKTIME_API/approvals/history?page=1&pageSize=20
```

## 调用示例

待我审批：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/approvals/pending"
```

我提交的、还在审批中的：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/approvals/my-submissions?status=pending"
```

## 返回结构（待审批）

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 3,
        "targetType": "timesheet",
        "targetId": 12,
        "status": "pending",
        "submitter": { "id": 5, "realName": "王员工" },
        "createdAt": "2026-07-10T09:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

## 回答要求

- 中文回答。`targetType` 映射：`timesheet`→工时、`overtime`→加班、`weekly_report`→周报。
- 区分"待我审批的"和"我提交等别人审批的"。
