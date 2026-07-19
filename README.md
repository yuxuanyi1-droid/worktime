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

```bash
# 1. 安装依赖并创建统一配置
npm run install:all
cp .env.example .env
# 编辑根 .env，填写 JWT_SECRET、PostgreSQL、Redis 等配置

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

前端与 API 同源时会自动信任当前请求来源；跨域、代理 Host 与公网域名不一致或需要额外回调域名时，在根 `.env` 显式配置：

```bash
OIDC_REDIRECT_ORIGINS=https://sso.qinyuan.cloud
```

多个 origin 使用英文逗号分隔。这里只填写 `协议 + 域名 + 端口`，不要附加 `/worktime`。OIDC 服务商后台仍需登记完整回调地址，例如：

```text
https://sso.qinyuan.cloud/worktime/oidc/callback
```

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
| **AI 助手** | 全局悬浮聊天窗，自然语言查询工时/审批/加班/周报，流式回答 + 思考过程折叠 |

### AI 助手

右下角悬浮按钮点开即用的 AI 工时助手，基于 [pi agent SDK](https://pi.dev)（`@earendil-works/pi-coding-agent`）+ 后端 Skill 实现，用户用自然语言提问即可查询自己的工时、审批、加班、周报。

**架构：**
- 后端 `server/src/ai/`：pi agent SDK 封装在 Worker 线程（避免 ESM/CJS 死锁），通过 `/api/v1/agent/chat` 以 **SSE（Server-Sent Events）** 流式推送 agent 事件（思考、工具调用、正文增量）。
- Skill（`server/src/ai/skills/`）：每个 Skill 是一段 Markdown 指令，agent 用 bash + PAT 调用工时 API 完成查询，结果回传给模型组织回答。
- 前端 `client/src/components/AgentChat/`：裸 fetch + ReadableStream 解析自定义 SSE 流（绕过 axios 的 JSON 解析与 30s 超时），`useChat` 维护消息状态。

**聊天界面特性：**
- **流式输出**：边生成边显示，支持中途停止。
- **过程折叠**：把模型的「思考 → 工具调用 → 思考 → 工具调用」按真实时序交织记录，统一折叠成一行「执行中 Xs / 已完成 · 用时 Xs」，展开可逐项查看，正文只显示最终答案。
- **Markdown 渲染**：代码块语法高亮（按需加载 PrismLight）+ 复制按钮、表格/列表/引用块暖色调样式。
- **消息操作**：每条回答可一键复制；最后一条回答支持重新生成。
- **悬浮卡片式 UI**：自定义浮窗（非 Drawer），约 2/3 视口高、四周留白、16px 圆角，贴合项目暖色调设计系统。

> AI 功能需在仓库根 `.env` 配置 `AI_API_KEY` 等，未配置时聊天接口返回 503 提示。

## 工程化与质量保证

### 数据一致性
- **事务化**：工时提交/修改、审批通过/撤回、权限授予等所有多步写操作统一包裹数据库事务，中途失败自动回滚
- **提交分组序列**：`SubmissionSequence` 计数器替代 `SELECT MAX+1`，事务内原子分配，消除并发竞争
- **数据精度**：工时/加班/周报时长使用 `numeric(10,2)` 存储，避免 float 累计精度误差
- **删除保护**：删除用户/项目前检查关联工时，防止孤儿数据和悬空引用

### 安全
- **Token 版本号**：JWT 携带 `tokenVersion`，改密/登出时 +1 使所有旧 Token 立即失效
- **限流**：express-rate-limit 全局限流（15 分钟/1000 次）+ 登录专用限流（10 分钟/20 次）
- **统一错误处理**：`BusinessError` 区分业务错误（400 + 友好提示）与系统错误（500 + 不泄露内部细节）
- **审计日志**：改密、用户禁用/删除、角色权限变更、审批决策、权限授予/撤销等高敏感操作全程留痕

### 性能
- **数据库索引**：工时、通知、审计等高频查询表均建立复合索引
- **去 N+1**：审批列表、抄送列表批量查询（按类型 `In(...)` 一次性取目标/申请人/实例）
- **SQL 下推**：公告可见性判断下推到 SQL where，避免全表扫描+内存过滤
- **权限缓存**：auth 中间件一次算出权限集挂到请求对象，permission 中间件复用

### 数据库迁移
- 关闭默认 `synchronize`（仅 `TYPEORM_SYNCHRONIZE=true` 显式开启），防止生产自动改表丢数据
- `ensureSchema()`：空库自动建表、老库跳过、始终运行 migration
- 增量 migration 平滑升级（如新增字段、补建索引），老库无需删数据重建

### 可观测性
- **pino 结构化日志**：开发环境 pretty 打印，生产环境 JSON 行（便于 ELK/Loki 采集）
- **Prometheus 指标**：`/api/metrics` 暴露 HTTP 请求计数/耗时直方图 + 进程指标
- 审计日志写入失败不再静默吞掉，记录到日志便于排查

### 测试
- vitest 单元测试覆盖核心逻辑：`BusinessError`、输入校验（`validation`）、权限码蕴含展开、报表去重（含修改审批场景）
- 运行：`cd server && npm run test`

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
└── package.json             # Monorepo 配置
```

## 数据库说明

项目生产数据库统一使用 **PostgreSQL**。连接参数位于仓库根 `.env`：`DB_HOST`、`DB_PORT`、`DB_USERNAME`、`DB_PASSWORD` 和 `DB_DATABASE`。

Schema 由实体定义驱动，通过 `ensureSchema()`（空库自动建表）+ migration（增量升级）管理。修改实体后：
- 编辑实体后生成并人工检查 migration，不依赖 `synchronize` 自动改表。
- 运行 `cd server && npm run migration:run` 应用 migration。
- migration 必须提供可用的 `down`，可通过 `npm run migration:revert` 回滚。
- 已有生产数据时不得删库重 seed。
