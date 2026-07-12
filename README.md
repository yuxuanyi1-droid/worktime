# 工时管理系统 (Worktime Management System)

企业级工时管理系统，支持工时填报、加班管理、周报编写、审批流转和报表统计。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + TypeScript + Ant Design 5 + ECharts + Zustand |
| 后端 | Express + TypeScript + TypeORM + JWT |
| 数据库 | **SQLite**（零配置，开箱即用） |
| 可观测性 | pino 结构化日志 + prom-client 指标 |
| 测试 | vitest 单元测试 |

## 快速启动

```bash
# 1. 安装依赖
npm install
cd server && npm install
cd ../client && npm install

# 2. 初始化数据库（自动创建表和种子数据）
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

> 首次使用复制 `.env.example` 为 `.env`。后端业务配置（JWT、DB_PATH 等）仍在 `server/.env`。

### 子路径部署

整个应用可挂在固定子路径下（如 `https://your-domain.com/worktime/`），由根 `.env` 的 `BASE_PATH` 统一驱动，前后端自动联动：

```bash
# 根 .env
BASE_PATH=/worktime   # 必须以 / 开头，不带尾斜杠；留空 = 根路径部署（默认）
```

**部署步骤：**

1. 后端：在根 `.env` 设置 `BASE_PATH=/worktime`，重启 `node dist/app.js`，API 路由自动变为 `/worktime/api/v1`。
2. 前端：用相同 `BASE_PATH` 构建一次（base 是构建期固化的）：
   ```bash
   cd client && npm run build   # 产物的静态资源引用自动带 /worktime/ 前缀
   ```
3. Nginx（示例）：
   ```nginx
   # 前端静态资源
   location /worktime/ {
       alias /path/to/client/dist/;
       try_files $uri $uri/ /worktime/index.html;
   }
   # 后端 API 反代
   location /worktime/api/ {
       proxy_pass http://127.0.0.1:3000;   # 注意：后端已自带 /worktime/api 前缀，proxy_pass 不带尾路径
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
   }
   ```

> 开发期（`npm run dev`）`BASE_PATH` 留空即可，仍为根路径，不受影响。

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
│   ├── data/worktime.db     # SQLite 数据库文件（自动创建）
│   ├── src/
│   │   ├── config/          # 数据库 & JWT 配置
│   │   ├── entities/        # 数据实体（24 张表）
│   │   ├── middleware/      # 认证/权限/错误处理/限流/指标
│   │   ├── migrations/      # 数据库迁移
│   │   ├── routes/          # 11 个 API 路由模块
│   │   ├── services/        # 13 个业务服务
│   │   ├── utils/           # 错误类/校验/日志/asyncHandler
│   │   └── seed.ts          # 种子数据初始化
│   └── .env
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

项目使用 **SQLite** 作为数据库，无需安装任何数据库软件。数据库文件位于 `server/data/worktime.db`，首次运行 `npm run seed` 时自动创建。

Schema 由实体定义驱动，通过 `ensureSchema()`（空库自动建表）+ migration（增量升级）管理。修改实体后：
- 开发环境：设置 `TYPEORM_SYNCHRONIZE=true` 可让 TypeORM 自动同步表结构
- 生产环境：新增 migration 文件（`src/migrations/`）管理变更，`npm run migration:run` 执行
