---
name: query-my-reports
description: 查询当前用户的工时统计报表与仪表盘数据
invocation:
  - 用户问"我的报表""我的工时统计""工时报表""个人统计""仪表盘""数据概况"
---

# 查询我的报表统计

查询**当前用户**的工时统计报表。

## 认证

请求带 `Authorization: Bearer $WORKTIME_PAT`，base 地址 `$WORKTIME_API`。

## 接口

### 1. 个人报表（按日期范围统计工时/加班汇总）

```
GET $WORKTIME_API/reports/personal
```

| 参数 | 说明 | 示例 |
|---|---|---|
| `startDate` | 起始日期 | `2026-07-01` |
| `endDate` | 结束日期 | `2026-07-31` |

### 2. 仪表盘概况

```
GET $WORKTIME_API/reports/dashboard
```

返回当前用户的概览数据（本月工时、待审批数、待提交项等），无需日期参数。

## 调用示例

本月个人报表：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/reports/personal?startDate=2026-07-01&endDate=2026-07-31"
```

仪表盘：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/reports/dashboard"
```

## 回答要求

- 中文回答，突出关键数字（总工时、平均日工时、待处理事项数）。
- 用户没说日期范围时，默认查"本月"。
- 如果返回 403，说明当前用户没有 `report:view:self` 权限，请如实告知用户。
