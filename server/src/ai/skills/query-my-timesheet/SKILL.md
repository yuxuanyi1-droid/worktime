---
name: query-my-timesheet
description: 查询当前用户自己的工时记录，可按日期范围和状态过滤
invocation:
  - 用户问"我的工时""我填了多少工时""我这周的工时""我提交的工时""工时记录"
---

# 查询我的工时

通过本系统的 REST API 查询**当前用户**的工时记录。

## 认证

所有请求需带 `Authorization: Bearer $WORKTIME_PAT` 头。令牌已注入环境变量，curl 示例中直接引用 `$WORKTIME_PAT` 即可。

API base 地址从 `$WORKTIME_API` 读取（如 `http://localhost:3000/api/v1`）。

## 接口

```
GET $WORKTIME_API/timesheets/my
```

### Query 参数（均可选）

| 参数 | 说明 | 示例 |
|---|---|---|
| `startDate` | 起始日期 YYYY-MM-DD | `2026-07-01` |
| `endDate` | 结束日期 YYYY-MM-DD | `2026-07-13` |
| `status` | 状态：`draft`草稿 / `submitted`已提交 / `approved`已通过 / `rejected`已驳回 | `submitted` |
| `page` | 页码，默认 1 | `1` |
| `pageSize` | 每页条数，默认 50 | `50` |
| `includeAll` | 是否返回全部版本（含历史修改版本），默认 false | `false` |

## 调用示例

查询本周（含状态）的工时：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/timesheets/my?startDate=2026-07-07&endDate=2026-07-13"
```

只看草稿状态的工时：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/timesheets/my?status=draft"
```

## 返回结构

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 12,
        "date": "2026-07-10",
        "hours": 8.0,
        "status": "approved",
        "project": { "id": 1, "name": "工时管理系统" },
        "content": "完成工时模块开发"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 50
  }
}
```

关键字段：`date`（日期）、`hours`（工时数）、`status`（状态）、`project.name`（项目名）、`content`（工作内容）。

## 回答要求

- 用中文回答，把工时按日期/项目归类总结。
- 用户问"多少工时"时，给出总小时数（sum hours）。
- 日期范围未明确时，默认查"本周"（周一至今天）或询问用户。
