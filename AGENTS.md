# AGENTS.md — Worktime Management System (工时管理系统)

Monorepo: `server/` (Express + TypeScript + TypeORM + PostgreSQL + Redis + JWT) and `client/` (React 18 + TS + Ant Design 5 + Zustand + ECharts). Orchestrated from the repo root with `concurrently`; production uses Caddy in front of three API instances plus one independent approval Worker. User-facing strings, comments, and commit messages are **Chinese** — match that.

> **项目当前处于开发阶段。** 数据库结构可以直接随实体调整，不要求为每次 schema 变更编写 migration，也不要求兼容已有开发数据。需要快速同步结构时可在本地设置 `TYPEORM_SYNCHRONIZE=true`；需要干净数据时可重建开发库后重新 seed。

## Commands

Run from the relevant package dir unless noted.

| Task | Command |
|------|---------|
| Install everything | `npm run install:all` (root) |
| Dev (both apps) | `npm run dev` (root) |
| Dev server only | `cd server && npm run dev` (`tsx watch src/app.ts`) |
| Dev client only | `cd client && npm run dev` (vite) |
| Seed DB | `cd server && npm run seed` (`tsx src/seed.ts`) |
| All tests | `npm test` (root; server + client) |
| Server tests | `npm run test:server` |
| Client tests | `npm run test:client` |
| Coverage | `npm run test:coverage` |
| Build | `npm run build` (root; server TypeScript + client `tsc -b`/Vite) |
| AI smoke | `npm run test:smoke:ai` (requires a running environment) |
| Production stack | `bash server/scripts/production-stack.sh build/start/status/logs/restart/stop` |

No lint/format scripts exist. No CI. Client type checking runs inside `build`; client tests are orchestrated from the root because all tests live under `tests/`.

## Env (single source of truth)

- Repo-root `.env` is the **single source of truth** for ports, JWT, PostgreSQL, Redis, OIDC, TT and AI settings. Copy `.env.example` → `.env`; do not introduce or depend on `server/.env`.
- `server/src/config/env.ts` loads only the repo-root `.env`. Vite also reads the root file. Import `config/env` at the top of every backend entry point.
- Required backend settings include a strong `JWT_SECRET` and PostgreSQL `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD`/`DB_DATABASE`. Redis is required for the documented multi-instance approval queue and cross-process coordination.
- Node.js must be >=22.19.0; Node.js 24 is recommended. Do not add project-local scripts that mutate a developer's fnm/nvm/PATH setup—document environment setup in `README.md`.

## Backend layer rules (`server/src/`)

- **routes → services → entities (repositories).** Routes are thin: validate with `utils/validation.ts` helpers, delegate to a service, return `res.json({ code: 0, data, message })`, wrap bodies in `try { ... } catch (e) { next(e) }`. Do NOT use `asyncHandler` (defined but unused).
- **Services are classes** that hold repositories via `AppDataSource.getRepository(Entity)`. Throw `BusinessError(message, statusCode?, code?)` for any user-facing failure; `errorHandler` maps it to its statusCode. Plain `Error` → 500 with generic message (message exposed only when `NODE_ENV=development`). Success envelope is `{ code: 0, data?, message? }`.
- **Transactions:** services that do multi-step writes must accept `EntityManager?` in the constructor and expose repos via a getter bound to `this.manager ?? AppDataSource`. Inside `AppDataSource.transaction(async (manager) => { ... })`, construct tx-scoped service instances (`new XService(manager)`). See `services/timesheetService.ts` (`submit`/`submitByRows`) for the canonical pattern.
- **Notifications are deferred to after-commit** (`flushNotifications`) so they never roll back business writes. `AuditService`/`NotificationService` do not take a manager — they write on the default connection.
- **Validation:** use `utils/validation.ts` (`parsePositiveInt`, `parsePagination`, `parseDateString` strict `YYYY-MM-DD`, `parseHours` 0<h≤24, etc.) rather than ad-hoc checks.
- **Audit logging is opt-in per route** (`new AuditService().log(...)`, best-effort internal try/catch) — there is no audit middleware.
- **tokenVersion:** login signs `{ ..., v: user.tokenVersion }`; `authMiddleware` rejects when `decoded.v !== user.tokenVersion`; `changePassword`/`logout` do `tokenVersion += 1`.
- **Approval versioning:** approved timesheets/overtime/weekly-reports are never mutated back to draft — edits mark the old record `deprecated` and create a new one re-entering approval.
- **Logging:** use `utils/logger.ts`; Authorization, Cookie, tokens, API keys and client secrets are centrally redacted. Never interpolate credentials or raw request headers into message strings, because string content cannot be structurally redacted.
- **`@/` alias exists in tsconfig but is unused** — use relative imports.

## Backend schema (开发阶段)

- DB: PostgreSQL is the only supported production database. The SQLite branch remains only for historical/local compatibility and must not drive new schema design.
- **改表流程：直接编辑 `entities/` 下实体类 → 在 `config/database.ts` 显式登记新增实体 → 同步更新 `tests/server/helpers/database.ts` 的 `loadEntities()` → 在本地用 `TYPEORM_SYNCHRONIZE=true` 启动并验证。**
- 当前开发阶段不要求新增 migration，也不要求保留已有开发数据；需要时可以重建开发数据库并重新执行 `cd server && npm run seed`。
- 已有 migration 文件属于历史初始化能力，不需要为普通开发改动同步维护；除非用户明确要求准备可升级部署方案，否则不要主动生成 migration。
- `TYPEORM_SYNCHRONIZE=true` 只用于本地开发。准备正式部署前应重新评估 schema 管理策略，并在生产环境关闭自动同步。
- Money/hours 使用 `numeric(10,2)`。`SubmissionSequence` 分配提交分组序号（替代 `MAX+1`）。

## AI assistant (`server/src/ai/`, `client/src/components/AgentChat/`)

- Each API process owns isolated AI `worker_threads`; the standalone `approvalWorker.js` is unrelated and only consumes the Redis approval queue.
- The pi SDK is initialized through `ModelRuntime`. Inject provider credentials with `setRuntimeApiKey`; never write `AI_API_KEY` to `auth.json`, logs, session files or browser events.
- Agent capabilities stay read-only: expose only `worktime_query`, use a short-lived user-scoped JWT, and keep existing route permission checks. Do not add shell, filesystem, arbitrary HTTP or mutation tools without an explicit security review.
- SSE output must pass through the sanitizer in `routes/agent.ts`. Raw chain-of-thought, SDK internals, stack traces, access tokens and unknown tool arguments must never reach the browser.
- Preserve the two-level process UI: the process group is collapsed by default, and users can expand it and individual steps. Show safe derived summaries and sanitized tool details, not raw reasoning text.
- Date-relative questions use `Asia/Shanghai`. `weekly_timesheet_summary` must receive both Monday `weekStart` and Sunday `weekEnd` in strict `YYYY-MM-DD`.
- Multi-instance routing depends on Caddy's signed `worktime_ai_upstream` affinity Cookie. Any AI integration/smoke client must retain cookies across status, session, chat, history and delete requests.
- A normal SSE completion without non-empty final text is an error state and must surface the actionable Chinese retry message; do not display a thinking/process placeholder as the final answer.

## Tests

- 所有测试、测试辅助代码、恢复演练和压力测试脚本统一位于仓库根目录 `tests/`，禁止再放回 `server/src`、`client/src` 或 `server/scripts`。
- `tests/server/` 使用 Node 环境；`tests/client/` 使用 jsdom + Testing Library；配置位于 `tests/config/`。
- 内存数据库辅助代码位于 `tests/server/helpers/database.ts`。
- 根目录运行 `npm test` 执行前后端全部测试；`npm run test:coverage` 生成 `tests/coverage/` 报告。

## Frontend (`client/src/`)

- **Pages:** folder-per-feature with `index.tsx` default export. Add a route in `router/index.tsx` (lazy import + wrap in `<PermissionRoute permission="...">` if gated) and a menu entry in `components/Layout/MainLayout.tsx` (`allMenuItems` with `permission`).
- **API layer:** single axios instance in `utils/request.ts` (`baseURL: '/api/v1'`, 30s). Request interceptor injects `Authorization: Bearer <token>` from localStorage. Response interceptor treats `data.code !== 0` as failure (`message.error(data.message)`); HTTP 401 → `clearAuth()` + `'unauthorized'` event → soft redirect to `/login`. Add methods to `src/api/<domain>.ts` (one exported object per domain).
- **State:** Zustand (`stores/authStore.ts` persists token/user + multi-tab `'storage'` sync; `stores/appStore.ts`). Access via hooks or `useAuthStore.getState()`.
- **Permissions:** `hooks/usePermission.ts` — `hasPermission/hasAnyPermission/hasAllPermissions/hasRole`, with aliases + transitive implications; **admin role short-circuits to true**.
- **Types:** all shared types + label/color maps in one `types/index.ts` (`statusMap`, `projectStatusMap`, `overtimeTypeMap`, `stepTypeMap`). Reuse `<Tag color={statusMap[s]?.color}>`.
- **Styling:** plain inline `style={{}}` with the warm palette tokens (`colorPrimary #6B8F71`, bg `#FDFBF7`/`#F8F4ED`, text `#2C2418`, `borderRadius 12`). **No CSS Modules / Tailwind / styled-components.** Prefer `<PageContainer title extra>` for page layout. Charts via `<LazyEChart option={...}>` (echarts/core, Line/Bar/Pie only).
- **Error surfacing:** extract `error.response?.data?.message` with a Chinese fallback (`message.error`).
- **Path alias:** `@` → `src` (used in client, unlike server).
- Code style (no formatter configured): 2-space indent, single quotes (JS) / double quotes (JSX), trailing commas, semicolons.

## Gotchas

- 开发阶段允许通过 `TYPEORM_SYNCHRONIZE=true` 直接同步实体结构，也允许重建开发库并重新 seed；不要把本地数据库或运行数据提交到 Git。
- `nul` 和 `server/nul` 是 Windows 误产生的杂散文件（`.gitignore` 里记为 `_nul`）；忽略即可。
- 默认账号（seed 后，密码均为 `123456`）：`admin`、`manager1`、`leader1/2`、`subleader1`、`employee1/2`。
- `server/data/` contains generated AI model config, session state, runtime logs/PIDs and other local data (gitignored) — never commit it.
- Helmet, CORS and rate limiting are enabled. Do not weaken security headers, trusted-origin validation, proxy trust or login/global limiter behavior without tests.
- `hooks/useRequest.ts` 存在但页面仍手写 `useState(loading/error)` + try/catch——两种方式皆可。
- 设了 `trust proxy = 1`（反向代理后限流依赖它）。

## Before editing sensitive areas, read
- `server/src/config/database.ts` + `server/src/entities/` (development schema and entity registration)
- `server/src/services/timesheetService.ts` (transaction / approval-versioning pattern)
- `server/src/middleware/auth.ts` + `permission.ts` (auth/permission model)
- `client/src/utils/request.ts` + `client/src/router/index.tsx` (frontend auth flow & routing)
- `server/src/ai/agentWorker.ts` + `server/src/routes/agent.ts` + `client/src/components/AgentChat/` (AI runtime, SSE sanitization, process folding)
- `server/src/utils/logger.ts` (central credential redaction)
