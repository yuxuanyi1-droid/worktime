# 工时管理系统 (Worktime Management System)

企业级工时管理系统，支持工时填报、加班管理、周报编写、审批流转和报表统计。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + TypeScript + Ant Design 5 + ECharts + Zustand |
| 后端 | Express + TypeScript + TypeORM + JWT |
| 数据库 | **PostgreSQL** + TypeORM migration |
| 缓存/队列 | Redis（多实例限流、缓存、审批队列） |
| 可观测性 | pino 结构化日志 + prom-client 指标 |
| 测试 | vitest 单元测试 |

## 快速启动

运行环境要求 Node.js 22.19.0 及以上，推荐 Node.js 24。使用 fnm 时请先执行 `fnm use 24`；如果仍命中 Windows 挂载目录中的 Node，请用 `which node`、`node -v` 检查 WSL 当前解析到的可执行文件。

```bash
# 1. 安装依赖并创建统一配置
npm run install:all
cp .env.example .env
# 编辑根 .env，填写 JWT_SECRET、PostgreSQL 等配置；多实例部署还需配置 Redis

# 2. 初始化数据库
cd server && npm run seed

# 3. 启动前后端
cd .. && npm run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:3000

### 修改端口

前后端端口在**仓库根 `.env`**（单一真相源）中配置，前后端、CORS、代理会自动联动：

```bash
# 根 .env
PORT=3000        # 后端 API 端口
CLIENT_PORT=5173 # 前端开发服务器端口
```

> 首次使用复制 `.env.example` 为 `.env`。前后端配置统一从仓库根 `.env` 读取；不要再把业务配置写入 `server/.env`。

### 子路径部署

整个应用可挂在固定子路径下（如 `https://your-domain.com/worktime/`），由根 `.env` 的 `BASE_PATH` 统一驱动，前后端自动联动：

```bash
# 根 .env
BASE_PATH=/worktime   # 必须以 / 开头，不带尾斜杠；留空 = 根路径部署（默认）
```

前端的 `BASE_PATH` 在构建期固化，修改后需要重新构建。生产环境可直接使用下文的一键脚本同时构建前后端。

> 开发期（`npm run dev`）`BASE_PATH` 留空即可，仍为根路径，不受影响。

### OIDC 回调域名

如果需要让 OAuth 始终使用固定回调域名，在根 `.env` 只配置 origin；回调路径自动读取 `BASE_PATH`：

```bash
OIDC_REDIRECT_ORIGIN=https://sso.qinyuan.cloud
BASE_PATH=/worktime
```

最终 `redirect_uri` 固定为：

```text
https://sso.qinyuan.cloud/worktime/oidc/callback
```

`OIDC_REDIRECT_ORIGIN` 同时用于登录发起和回调换 token，优先级最高，只允许填写协议、域名和可选端口，不能带 path/query。组合后的地址必须能够实际访问同一套前端回调页面，并在 OIDC 服务商后台登记完全相同的 URL。

开发/测试环境中前端与 API 同源时会自动信任当前请求来源。生产环境为防止伪造 Host 形成开放回调，必须配置推荐的 `OIDC_REDIRECT_ORIGIN`，或在根 `.env` 显式配置允许来源：

```bash
OIDC_REDIRECT_ORIGINS=https://sso.qinyuan.cloud
```

多个 origin 使用英文逗号分隔。这里只填写 `协议 + 域名 + 端口`，不要附加 `/worktime`。OIDC 服务商后台仍需登记完整回调地址，例如：

```text
https://sso.qinyuan.cloud/worktime/oidc/callback
```

身份源的 discovery、换令牌和用户信息请求默认最多等待 10 秒，可通过 `OIDC_REQUEST_TIMEOUT_MS` 在 1000～60000 毫秒范围内调整。网络错误、超时和无效响应统一返回可恢复的身份源错误，不会把授权码、令牌或 client secret 写入日志。

## 生产多实例部署

当前 `Caddyfile` 面向 4 核 8 GB 服务器，统一入口保持为 `127.0.0.1:3000`：

```text
Cloudflare Tunnel / 其他入口
              ↓
       Caddy :3000
       ├─ API :3011（DB_POOL_MAX=16）
       ├─ API :3012（DB_POOL_MAX=16）
       └─ API :3013（DB_POOL_MAX=16）
              ↓
       独立审批 Worker（DB_POOL_MAX=6，batch=50）
```

三个 API 都设置 `APPROVAL_WORKER=0`，只负责接收请求和入队；独立 Worker 统一消费 Redis 审批队列。所有实例共享 PostgreSQL、Redis 和根 `.env`。

AI 生成任务并不是上述独立审批 Worker 的职责。每个 API 实例内部各自运行受隔离的 AI `worker_threads`，Caddy 使用签名 Cookie 将同一 AI 会话固定到一个 API 实例；独立进程 `approvalWorker.js` 只消费审批队列。

审批 Worker 保留批处理吞吐；批次失败时会自动逐条隔离，单条任务达到 `APPROVAL_MAX_ATTEMPTS` 后进入死信 Stream，避免坏任务阻塞同批正常审批。`/api/metrics` 暴露 `approval_queue_messages` 与 `approval_dead_letter_messages`，后者大于 0 时应告警并人工排查。

### 一键管理脚本

脚本会精确记录每个进程的 PID，启动前检查端口，等待健康检查通过，并在启动失败时清理本次进程。日志和 PID 位于已忽略的 `server/data/runtime/`。

```bash
# 首次部署或代码更新后构建前后端
bash server/scripts/production-stack.sh build

# 启动 3 个 API、独立 Worker 和 Caddy
bash server/scripts/production-stack.sh start

# 查看状态
bash server/scripts/production-stack.sh status

# 查看全部日志，或只看某个进程
bash server/scripts/production-stack.sh logs
bash server/scripts/production-stack.sh logs caddy
bash server/scripts/production-stack.sh logs api-3011

# 重启或停止
bash server/scripts/production-stack.sh restart
bash server/scripts/production-stack.sh stop
```

如需调整连接池，可在运行脚本时覆盖：

```bash
WORKTIME_API_DB_POOL_MAX=12 WORKTIME_WORKER_DB_POOL_MAX=6 \
  bash server/scripts/production-stack.sh start
```

Cloudflare Tunnel 的 Published application service 建议填写明确的 IPv4 回环地址，避免 `localhost` 的 IPv4/IPv6 解析差异：

```text
http://127.0.0.1:3000
```

公网 HTTPS 在 Cloudflare 终止，Cloudflare 到本机 Caddy 使用 HTTP 属于正常的内部链路。Caddy 接受 Tunnel 保留的公网 Host，但只绑定本机回环地址，不直接暴露服务端口。

## 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | admin | 123456 |
| 部门经理 | manager1 | 123456 |
| 组长 | leader1 / leader2 | 123456 |
| 副组长 | subleader1 | 123456 |
| 员工 | employee1 / employee2 | 123456 |

## 功能模块

| 模块 | 功能 |
|------|------|
| **登录认证** | JWT 登录/登出、改密/登出后旧 Token 立即失效（tokenVersion 机制） |
| **首页仪表盘** | 统计卡片、工时趋势图、待办事项 |
| **工时填报** | 按日期/项目填报、批量提交审批、复制上周（带覆盖确认） |
| **加班提报** | 周末/节假日/工作日加班申请、创建并提交一体化 |
| **周报管理** | 周报编写、关联本周工时、提交审批 |
| **审批中心** | 待审批列表、批量通过/驳回（带 loading 防重复）、抄送传阅 |
| **报表中心** | 个人/部门/组别/项目/加班报表、图表展示、全类型 Excel 导出 |
| **权限申请** | 细粒度权限申请-审批-授予闭环 |
| **系统管理** | 部门/分组/用户/角色/权限/项目/审批流程/公告/审计日志 CRUD |
| **AI 助手** | 全局悬浮聊天窗，自然语言只读查询工时/审批/加班/周报，流式回答 + 工具执行过程折叠 |

### AI 助手

右下角悬浮按钮点开即用的 AI 工时助手，基于 [pi agent SDK](https://pi.dev)（`@earendil-works/pi-coding-agent`）和受限只读工具实现。用户用自然语言提问即可查询自己有权访问的工时、审批、加班、周报；未配置 AI 时前端不会展示入口。

**架构：**
- 后端 `server/src/ai/`：pi agent SDK 封装在 Worker 线程（避免 ESM/CJS 死锁），通过 `/api/v1/agent/chat` 以 **SSE（Server-Sent Events）** 流式推送工具状态和正文增量。
- 模型运行时：使用当前 pi SDK 的 `ModelRuntime` 加载 `server/data/pi-models.json`；API key 仅注入进程内运行时，不写入 `auth.json`。生成的模型配置权限限制为当前用户可读写。
- 工具边界：Agent 只注册 `worktime_query`，不提供 bash、文件读取或任意 HTTP 工具；内部使用按用户签发的短期 JWT 调用本系统只读接口，数据范围继续经过原有权限校验。
- 日期语义：系统提示按 `Asia/Shanghai` 注入当前日期和本周范围；调用个人周工时汇总时必须同时传入周一 `weekStart` 和周日 `weekEnd`，避免跨年、跨月或服务端默认日期造成误差。
- 容量保护：每个实例默认同时生成 12 路、排队 100 路、驻留 200 个会话；同一会话串行执行，并在超限时返回明确的繁忙提示。
- 容量观测：`/api/metrics` 提供 `ai_active_prompts`、`ai_queued_prompts`、`ai_resident_sessions`，扩容应以持续排队和 P95 等待时间为依据。
- 多实例路由：`Caddyfile` 对 `/agent/*` 使用签名 Cookie 会话亲和，确保创建会话、SSE、消息排队和停止操作落在同一 AI Worker；其他 API 仍使用 `least_conn`。生产应配置 `CADDY_LB_COOKIE_SECRET`。
- 前端 `client/src/components/AgentChat/`：裸 fetch + ReadableStream 解析自定义 SSE 流（绕过 axios 的 JSON 解析与 30s 超时），`useChat` 维护消息状态。

**聊天界面特性：**
- **流式输出**：边生成边显示，支持中途停止。
- **过程折叠**：处理过程默认折叠，展开后每个分析/工具步骤仍可继续展开；分析步骤展示安全摘要和工具执行状态，不向浏览器传输模型原始推理文本，正文只显示最终答案。
- **Markdown 渲染**：代码块语法高亮（按需加载 PrismLight）+ 复制按钮、表格/列表/引用块样式；外部图片默认隐藏，链接协议受限。
- **消息操作**：每条回答可一键复制；最后一条回答支持重新生成。
- **悬浮卡片式 UI**：自定义浮窗（非 Drawer），约 2/3 视口高、四周留白、16px 圆角，贴合项目暖色调设计系统。

> AI 功能需在仓库根 `.env` 配置 `AI_API_KEY` 等。未配置时 `/agent/status` 返回 `enabled: false`，聊天接口仍以 503 明确拒绝直接调用。

**验证与排障：**

```bash
# 先启动完整环境，再从仓库根目录执行真实登录、SSE、工具调用和历史记录烟测
npm run test:smoke:ai

# 子路径或非默认地址可显式覆盖
AI_SMOKE_BASE_URL=http://127.0.0.1:3000/worktime/api/v1 \
AI_SMOKE_QUESTION='我这周填了多少工时' \
node tests/smoke/ai-api-smoke.mjs
```

- 多实例烟测必须保留服务端下发的 AI 亲和 Cookie，否则后续请求可能被转发到没有该会话的实例。
- AI 只产生分析过程但没有最终正文时，前端会提示“AI 未生成可展示的回答，请重新生成”，不再把过程占位文案误当成答案。
- 出现 500 时优先查看 `server/data/runtime/logs/api-*.log`；当前日志器会自动脱敏 Authorization、Cookie、API key、访问令牌和客户端密钥。脱敏只对新写入日志生效，升级前产生的旧日志应按运维策略清理，并轮换可能已落盘的凭据。

## 工程化与质量保证

### 数据一致性
- **事务化**：工时提交/修改、审批通过/撤回、权限授予等所有多步写操作统一包裹数据库事务，中途失败自动回滚
- **提交分组序列**：`SubmissionSequence` 计数器替代 `SELECT MAX+1`，事务内原子分配，消除并发竞争
- **数据精度**：工时/加班/周报时长使用 `numeric(10,2)` 存储，避免 float 累计精度误差
- **删除保护**：删除用户/项目前检查关联工时，防止孤儿数据和悬空引用

### 安全
- **Token 版本号**：JWT 携带 `tokenVersion`，改密/登出时 +1 使所有旧 Token 立即失效
- **限流**：express-rate-limit 全局限流（15 分钟/1000 次）+ 登录失败专用限流（10 分钟/100 次，可通过 `LOGIN_RATE_MAX` 调整）
- **统一错误处理**：`BusinessError` 区分业务错误（400 + 友好提示）与系统错误（500 + 不泄露内部细节）
- **审计日志**：改密、用户禁用/删除、角色权限变更、审批决策、权限授予/撤销等高敏感操作全程留痕
- **日志脱敏**：结构化日志统一遮蔽 Authorization、Cookie、Token、API key 和客户端密钥，禁止在业务日志中手工拼接敏感凭据

### 性能
- **数据库索引**：工时、通知、审计等高频查询表均建立复合索引
- **去 N+1**：审批列表、抄送列表批量查询（按类型 `In(...)` 一次性取目标/申请人/实例）
- **SQL 下推**：公告可见性判断下推到 SQL where，避免全表扫描+内存过滤
- **权限缓存**：auth 中间件一次算出权限集挂到请求对象，permission 中间件复用

### 数据库结构（开发阶段）
- 当前项目仍处于开发阶段，修改 TypeORM 实体后不要求编写 migration，也不要求兼容已有开发数据
- 本地可设置 `TYPEORM_SYNCHRONIZE=true`，启动时直接把实体结构同步到开发数据库
- 需要干净环境时可重建开发数据库并重新执行 seed；现有 migration 仅作为历史初始化能力保留
- 准备正式部署前需重新确定 schema 升级策略，并关闭生产环境的自动同步

### 可观测性
- **pino 结构化日志**：开发环境 pretty 打印，生产环境 JSON 行（便于 ELK/Loki 采集）
- **Prometheus 指标**：`/api/metrics` 暴露 HTTP 请求计数/耗时直方图 + 进程指标
- 审计日志写入失败不再静默吞掉，记录到日志便于排查

### 测试
- 所有自动化用例、性能脚本和恢复演练统一位于根目录 `tests/`，避免前后端测试分散。
- `npm test`：依次运行后端和前端测试；`npm run test:coverage`：生成 `tests/coverage/` 覆盖率报告。
- `npm run test:server` / `npm run test:client`：分别运行服务端或客户端测试。
- `npm run test:smoke:ai`：对已启动环境执行登录、AI 状态、建会话、SSE、历史持久化和删除的完整烟测；账号及地址可通过 `AI_SMOKE_*` 环境变量指定。

## 项目结构

```
├── server/                  # 后端
│   ├── data/                # 本地运行日志、PID 和临时数据（gitignore）
│   ├── src/
│   │   ├── config/          # 数据库 & JWT 配置
│   │   ├── entities/        # 数据实体（24 张表）
│   │   ├── middleware/      # 认证/权限/错误处理/限流/指标
│   │   ├── migrations/      # 数据库迁移
│   │   ├── routes/          # 11 个 API 路由模块
│   │   ├── services/        # 13 个业务服务
│   │   ├── utils/           # 错误类/校验/日志/asyncHandler
│   │   └── seed.ts          # 种子数据初始化
│   └── scripts/production-stack.sh # 生产多实例管理脚本
├── client/                  # 前端
│   └── src/
│       ├── api/             # API 调用模块
│       ├── components/      # 主布局/错误边界/PageContainer/图表
│       ├── hooks/           # useRequest/usePermission
│       ├── pages/           # 10+ 页面组件
│       ├── stores/          # Zustand 状态管理（含多 tab 同步）
│       ├── router/          # 路由配置（含权限守卫）
│       └── types/           # 类型定义
├── tests/                   # 前后端测试、覆盖率、性能与恢复脚本
└── package.json             # Monorepo 配置
```

## 数据库说明

项目数据库统一使用 **PostgreSQL**。连接参数位于仓库根 `.env`：`DB_HOST`、`DB_PORT`、`DB_USERNAME`、`DB_PASSWORD` 和 `DB_DATABASE`。

当前为开发阶段，Schema 直接由 TypeORM 实体定义驱动。修改实体后可在本地设置：

```bash
TYPEORM_SYNCHRONIZE=true
```

随后重启后端即可同步开发库结构。开发数据无需保持向后兼容，需要时可以重建开发数据库并重新执行 `cd server && npm run seed`。现有 migration 文件暂时保留，但普通开发改动无需新增或维护 migration；正式部署前再重新评估数据库升级方案。
