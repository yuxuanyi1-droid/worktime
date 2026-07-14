---
name: query-my-weekly-report
description: 查询当前用户自己的周报
invocation:
  - 用户问"我的周报""周报内容""这周周报""上周周报""周报状态"
---

# 查询我的周报

查询**当前用户**的周报。

## 认证

请求带 `Authorization: Bearer $WORKTIME_PAT`，base 地址 `$WORKTIME_API`。

## 接口

### 周报列表

```
GET $WORKTIME_API/weekly-reports/my
```

| 参数 | 说明 | 示例 |
|---|---|---|
| `page` / `pageSize` | 分页 | `1` / `20` |

### 指定周

```
GET $WORKTIME_API/weekly-reports/week?weekStart=2026-07-07
```

`weekStart` 为周一日期 YYYY-MM-DD。

## 调用示例

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/weekly-reports/my?pageSize=20"
```

查指定周：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/weekly-reports/week?weekStart=2026-07-07"
```

## 返回结构

```json
{
  "code": 0,
  "data": {
    "id": 8,
    "weekStart": "2026-07-07",
    "weekEnd": "2026-07-13",
    "status": "submitted",
    "content": "本周完成工时模块开发与测试...",
    "plan": "下周开始审批流改造"
  }
}
```

## 回答要求

- 中文回答。用户问"周报"时优先列最近几周；问"上周"时算出上周一日期。
- 展示 status（草稿/已提交/已通过）。
