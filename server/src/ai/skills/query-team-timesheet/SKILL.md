---
name: query-team-timesheet
description: 查询组内或部门的工时数据（需要组长/经理权限）
invocation:
  - 用户问"组内工时""团队工时""部门工时""下属工时""组员填了吗""谁没填工时"
---

# 查询团队工时

查询**组内/部门**的工时数据。**需要组长/经理权限**（`timesheet:view:group` 或 `timesheet:view:department`）。

## 认证

请求带 `Authorization: Bearer $WORKTIME_PAT`，base 地址 `$WORKTIME_API`。

## 接口

### 组/部门报表

```
GET $WORKTIME_API/reports/group?startDate=2026-07-01&endDate=2026-07-31
GET $WORKTIME_API/reports/department?startDate=2026-07-01&endDate=2026-07-31
```

> 选 group（本组）还是 department（本部门）取决于当前用户权限。组长用 group，部门经理用 department。

### 工时周汇总（查看某人某周）

```
GET $WORKTIME_API/timesheets/weekly-summary?userId=5&weekStart=2026-07-07
```

## 调用示例

本组本月工时报表：

```bash
curl -s -H "Authorization: Bearer $WORKTIME_PAT" \
  "$WORKTIME_API/reports/group?startDate=2026-07-01&endDate=2026-07-31"
```

## 回答要求

- 中文回答。如果返回 403，说明当前用户没有团队查看权限，请如实告知并建议去"权限申请"页面申请。
- 给出团队成员工时汇总，可指出工时异常（明显偏低/偏高）的成员。
- 用户没说日期范围时默认查"本周"。
