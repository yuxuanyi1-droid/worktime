# 功能覆盖矩阵

本矩阵以当前代码中的后端路由域和前端页面为功能清单。它描述的是“功能行为是否有自动化证据”，不把行覆盖率等同于功能完整性。

最后验证时间：2026-07-23。

| 功能域 | 前端交互证据 | 后端契约/集成证据 | 已覆盖的关键行为 | 状态 |
| --- | --- | --- | --- | --- |
| 登录与本地认证 | `client/pages/Login.test.tsx`、`Profile.test.tsx`、`stores/authStore.test.ts` | `server/routes/auth.test.ts`、`services/authService.integration.test.ts`、`middleware/auth*.test.ts` | 登录失败锁定、等价错误提示、JWT/tokenVersion、改密/登出失效、资料编辑、IdP 托管只读、AI 短期令牌 | 已覆盖 |
| OIDC / SIAM / 钉钉 | `Login.test.tsx`、`OidcCallback.test.tsx`、`utils/oidcIntent.test.ts` | `routes/oidc*.test.ts`、`services/oidc/*.test.ts`、`externalIdentityService.integration.test.ts` | provider 开关、state HMAC/过期/篡改、可信回调地址、登录/绑定发起者校验、JIT 建号与组织同步、并发唯一约束、解绑 | 已覆盖；真实 IdP 需联调 |
| 工作台 | `pages/Dashboard.test.tsx` | `routes/report.test.ts`、`services/reportService*.test.ts` | 权限化统计、日期与状态聚合、失败/重试、过期响应不覆盖新状态 | 已覆盖 |
| 工时填报 | `pages/Timesheet.test.tsx`、`utils/weeklyReportContent.test.ts` | `routes/timesheet.test.ts`、`services/timesheetService*.test.ts` | 单条/批量、项目与最小单位、重复和每日上限、周汇总、提交/撤回、已审批版本链、非活动项目拒绝 | 已覆盖 |
| 加班申请 | `pages/Overtime.test.tsx` | `routes/overtime.test.ts`、`services/overtimeService*.test.ts` | CRUD、项目校验、批量提交、状态/归属校验、月度已审批统计、错误恢复 | 已覆盖 |
| 周报 | `pages/WeeklyReport.test.tsx`、`utils/weeklyReportContent.test.ts` | `routes/weeklyReport.test.ts`、`services/weeklyReportService.integration.test.ts` | 草稿编辑、自动汇总、提交/撤回、只读状态、内容归一化与失败重试 | 已覆盖 |
| 审批中心 | `pages/Approval.test.tsx` | `routes/approval.test.ts`、`services/approval*.test.ts`、`approvalInstanceConstraint.test.ts` | 待办/历史/我的申请、同意/驳回/撤回、会签/或签、转交/抄送/分享、分页、幂等与并发推进、重新提交 | 已覆盖 |
| 项目管理 | `pages/Project.test.tsx` | `routes/system.test.ts`、`services/systemService.integration.test.ts`、`accessPolicyService.integration.test.ts` | 项目 CRUD、项目管理员、模块 SE、配额、组织筛选、管理范围、并发覆盖写 | 已覆盖 |
| 权限申请 | `pages/PermissionRequest.test.tsx`、`hooks/usePermission*.test.tsx` | `routes/permissionRequest.test.ts`、`permissionGovernanceService.integration.test.ts`、`accessPolicyService.integration.test.ts` | 仅可申请目录权限、范围授权、重复申请约束、审批生效/撤销、全局与范围权限严格区分 | 已覆盖 |
| PAT | `pages/Pat.test.tsx` | `routes/pat*.test.ts`、`services/patService.integration.test.ts` | 创建时一次性显示、仅存 hash、数量/名称/过期限制、撤销、并发创建、鉴权方法区分 | 已覆盖 |
| 通知中心 | `pages/NotificationCenter.test.tsx`、`components/MainLayout.test.tsx` | `routes/notification.test.ts`、`services/notificationService.test.ts` | 未读数量、单条已读、全部已读、已读项隐藏、独立列表、分页、重复操作幂等 | 已覆盖 |
| 公告与 TT | `pages/System.test.tsx` | `routes/announcement.test.ts`、`services/announcementService.test.ts`、`userAudienceService.test.ts`、`notifications/*.test.ts` | 全员/部门/分组/用户范围、SIAM 工号解析、无工号跳过、批量 TT、站内公告、编辑不重发、已读统计、删除 | 已覆盖；真实 TT 需联调 |
| 报表与导出 | `pages/Report.test.tsx` | `routes/report.test.ts`、`services/reportService*.test.ts` | 个人/组/部门/项目/加班、三级联动筛选、数据范围、范围化导出、Excel 参数与下载、旧请求失效 | 已覆盖 |
| 系统管理 | `pages/System.test.tsx` | `routes/system.test.ts`、`services/systemService.integration.test.ts`、`approvalFlowService.integration.test.ts` | 部门/分组/负责人、用户 CRUD、角色与权限目录、审批流版本/默认约束、公告、审计、品牌/单位/锁定日/提醒设置 | 已覆盖 |
| AI 助手 | `components/AgentChat.test.tsx`、`useChat.test.tsx`、`sseClient.test.ts` | `routes/agent.test.ts`、`ai/agentRunner.test.ts`、`agentWorker.test.ts`、`promptScheduler.test.ts` | 会话 CRUD、SSE、停止/重试/排队、短期内部令牌、工具白名单、会话隔离、安全链接/图片/Markdown、Worker 退出与超时 | 已覆盖；真实模型由烟测验证 |
| 审计日志 | `pages/System.test.tsx` | `routes/audit.test.ts`、`services/auditService.test.ts` | 独立权限入口、分页筛选、详情 JSON 可读化、服务端只读边界 | 已覆盖 |
| 队列、缓存和运行时 | 无独立页面 | `approvalQueue*.test.ts`、`approvalWorker.lifecycle.test.ts`、`app.lifecycle.test.ts`、`middleware/security.test.ts`、`middleware/metrics.test.ts` | Redis 降级、死信、未确认任务接管、优雅退出、限流、安全头、指标鉴权、AI Worker 预热 | 已覆盖核心行为 |

## 自动守卫

`server/architecture/testInventory.test.ts` 会持续检查：

- 每个 `server/src/routes/*.ts` 都有 `tests/server/routes/<name>.test.ts`；
- 每个 `client/src/pages/*/index.tsx` 都有 `tests/client/pages/<name>.test.tsx`；
- `server/` 和 `client/` 中不再散落 `*.test.*` 或 `*.spec.*` 文件。

## 覆盖率基线

- 后端：完整入口共 493 项测试；最近一次覆盖率采集中的 484 项行为测试为语句 78.30%、分支 63.25%、函数 82.79%、行 81.85%，另有 9 项清单/migration 结构守卫。
- 前端：185 项测试；语句 74.28%、分支 61.66%、函数 71.41%、行 78.12%。
- 后端全部 14 个路由域、前端全部 14 个页面均有直接测试，API 客户端契约为 100% 文件覆盖。

覆盖率未达到 100% 的主要部分是外部进程启动、真实 Redis/PostgreSQL 网络失败组合、AI SDK 的 ESM Worker 主循环、React 懒加载和少见渲染分支；这些不能仅靠增加无断言的行执行来替代真实联调和故障演练。
