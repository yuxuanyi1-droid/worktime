# AGENTS.md — Worktime Management System (工时管理系统)

Monorepo: `server/` (Express + TypeScript + TypeORM + better-sqlite3 + JWT) and `client/` (React 18 + TS + Ant Design 5 + Zustand + ECharts). Orchestrated from the repo root with `concurrently`. User-facing strings, comments, and commit messages are **Chinese** — match that.

> **项目处于开发阶段：修改实体时无需考虑数据库兼容性。** 直接改实体、开启 `TYPEORM_SYNCHRONIZE=true` 让 TypeORM 自动重建表结构、或删 `server/data/worktime.db` 后重新 `npm run seed` 即可，不必为 schema 变更编写 migration。

## Commands

Run from the relevant package dir unless noted.

| Task | Command |
|------|---------|
| Install everything | `npm run install:all` (root) |
| Dev (both apps) | `npm run dev` (root) |
| Dev server only | `cd server && npm run dev` (`tsx watch src/app.ts`) |
| Dev client only | `cd client && npm run dev` (vite) |
| Seed DB | `cd server && npm run seed` (`tsx src/seed.ts`) |
| Run migrations (optional) | `cd server && npm run migration:run` / `migration:revert` |
| Server unit tests | `cd server && npm test` (vitest run) |
| Client build | `npm run build` (root) → `cd client && tsc -b && vite build` |
| Reset DB | delete `server/data/worktime.db*`, then `cd server && npm run seed` |

No lint/format/typecheck scripts exist. No CI. Client `tsc -b` runs only inside `build`. Client has no test script.

## Env (single source of truth)

- Repo-root `.env` holds **ports only**: `PORT` (backend, default 3000) and `CLIENT_PORT` (vite, default 5173). Copy `.env.example` → `.env`. Vite reads root `.env`; CORS allowed origins derive from `CLIENT_PORT`.
- `server/.env` holds backend secrets: `JWT_SECRET` (required, weak/short secrets are rejected), `DB_PATH`, `TYPEORM_SYNCHRONIZE` (set `true` in dev to auto-sync schema), `JWT_EXPIRES_IN`, `LOG_LEVEL`, `METRICS_TOKEN`, `ALLOWED_ORIGINS`, `ALLOW_PROD_SEED`.
- Loading order is `server/src/config/env.ts`: root `.env` then `server/.env` (dotenv does not override; first wins). Import `config/env` at the top of any entry point.

## Backend layer rules (`server/src/`)

- **routes → services → entities (repositories).** Routes are thin: validate with `utils/validation.ts` helpers, delegate to a service, return `res.json({ code: 0, data, message })`, wrap bodies in `try { ... } catch (e) { next(e) }`. Do NOT use `asyncHandler` (defined but unused).
- **Services are classes** that hold repositories via `AppDataSource.getRepository(Entity)`. Throw `BusinessError(message, statusCode?, code?)` for any user-facing failure; `errorHandler` maps it to its statusCode. Plain `Error` → 500 with generic message (message exposed only when `NODE_ENV=development`). Success envelope is `{ code: 0, data?, message? }`.
- **Transactions:** services that do multi-step writes must accept `EntityManager?` in the constructor and expose repos via a getter bound to `this.manager ?? AppDataSource`. Inside `AppDataSource.transaction(async (manager) => { ... })`, construct tx-scoped service instances (`new XService(manager)`). See `services/timesheetService.ts` (`submit`/`submitByRows`) for the canonical pattern.
- **Notifications are deferred to after-commit** (`flushNotifications`) so they never roll back business writes. `AuditService`/`NotificationService` do not take a manager — they write on the default connection.
- **Validation:** use `utils/validation.ts` (`parsePositiveInt`, `parsePagination`, `parseDateString` strict `YYYY-MM-DD`, `parseHours` 0<h≤24, etc.) rather than ad-hoc checks.
- **Audit logging is opt-in per route** (`new AuditService().log(...)`, best-effort internal try/catch) — there is no audit middleware.
- **tokenVersion:** login signs `{ ..., v: user.tokenVersion }`; `authMiddleware` rejects when `decoded.v !== user.tokenVersion`; `changePassword`/`logout` do `tokenVersion += 1`.
- **Approval versioning:** approved timesheets/overtime/weekly-reports are never mutated back to draft — edits mark the old record `deprecated` and create a new one re-entering approval.
- **`@/` alias exists in tsconfig but is unused** — use relative imports.

## Backend schema (开发阶段，无需考虑兼容)

- DB: SQLite (`server/data/worktime.db`), WAL + `foreign_keys=ON` pragmas.
- **改表流程：直接编辑 `entities/` 下的实体类，设 `TYPEORM_SYNCHRONIZE=true`（或删库重 seed）。无需写 migration、无需保证向后兼容。**
- 实体类在 `config/database.ts` 的 `entities` 数组里**显式列出**（非 glob）——新增实体记得在此登记（以及 `test/setup.ts` 的 `loadEntities()`）。
- 现有 migration 在 `src/migrations/` 仅作历史保留；开发期可忽略，必要时删库重建即可。
- Money/hours 使用 `numeric(10,2)`。`SubmissionSequence` 分配提交分组序号（替代 `MAX+1`）。

## Backend tests

- vitest, `include: ['src/**/*.test.ts']`, tests **live alongside source** (e.g. `services/reportService.test.ts`, `utils/validation.test.ts`). In-memory DB helper in `src/test/setup.ts` (`setupTestDb`) exists for future integration tests.

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

- 开发阶段：schema 变更直接改实体 + synchronize，或删库重 seed，**不要**花时间写/维护 migration。
- `nul` 和 `server/nul` 是 Windows 误产生的杂散文件（`.gitignore` 里记为 `_nul`）；忽略即可。
- 默认账号（seed 后，密码均为 `123456`）：`admin`、`manager1`、`leader1/2`、`subleader1`、`employee1/2`。
- `data/worktime_test.db`（根）与 `server/data/*.db` 为本地数据库（已 gitignore）——不要提交。
- 无 helmet/安全头中间件；CORS + 限流（`globalLimiter` 1000/15min、`loginLimiter` 20/10min）是仅有的横向防护。
- `hooks/useRequest.ts` 存在但页面仍手写 `useState(loading/error)` + try/catch——两种方式皆可。
- 设了 `trust proxy = 1`（反向代理后限流依赖它）。

## Before editing sensitive areas, read
- `server/src/config/database.ts` + `server/src/entities/` (schema — dev: edit freely + synchronize)
- `server/src/services/timesheetService.ts` (transaction / approval-versioning pattern)
- `server/src/middleware/auth.ts` + `permission.ts` (auth/permission model)
- `client/src/utils/request.ts` + `client/src/router/index.tsx` (frontend auth flow & routing)
