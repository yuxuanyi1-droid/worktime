---
name: query-my-overtime
description: 查询当前用户自己的加班记录与加班统计
invocation:
  - 用户问"我的加班""加班记录""加了多久班""加班时长""调休"
---

# 查询我的加班

查询**当前用户**的加班申请记录。

## 认证

请求带 `Authorization: Bearer $WORKTIME_PAT`，base 地址 `$WORKTIME_API`。

## 接口

### 1. 加班列表

```
GET $WORKTIME_API/overtime/my
```

| 参数 | 说明 | 示例 |
|---|---|---|
| `startDate` | 起始日期 | `2026-07-01` |
| `endDate` | 结束日期 | `2026-07-13` |
| `status` | `draft` / `submitted` / `approved` / `rejected` | `approved` |
| `page` / `pageSize` | 分页 | `1` / `50` |

### 2. 加班统计

```
GET $WORKTIME_API/overtime/stats?startDate=2026-07-01&endDate=2026-07-31
```

返回该范围内总加班天数、按类型汇总等。

## 调用示例

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/overtime/my?startDate=2026-07-01&endDate=2026-07-13"
```

统计：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/overtime/stats?startDate=2026-07-01&endDate=2026-07-31"
```

## 返回结构（列表）

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 5,
        "startDate": "2026-07-08",
        "endDate": "2026-07-08",
        "startTime": "18:00",
        "endTime": "21:00",
        "days": 1.0,
        "type": "workday_evening",
        "status": "approved",
        "reason": "赶项目上线"
      }
    ],
    "total": 1
  }
}
```

## 回答要求

- 中文回答，给出总加班天数（单位"天"，不要说"小时"）。
- 区分工作日/周末/节假日加班（`type` 字段）。
