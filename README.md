# 工时管理系统 (Worktime Management System)

企业级工时管理系统，支持工时填报、加班管理、周报编写、审批流转和报表统计。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + TypeScript + Ant Design 5 + ECharts + Zustand |
| 后端 | Express + TypeScript + TypeORM + JWT |
| 数据库 | **SQLite**（零配置，开箱即用） |

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

## 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | admin | 123456 |
| 部门经理 | manager1 | 123456 |
| 组长 | leader1 | 123456 |
| 员工 | employee1 | 123456 |
| 员工 | employee2 | 123456 |

## 功能模块

| 模块 | 功能 |
|------|------|
| **登录认证** | JWT 登录/登出、Token 自动刷新 |
| **首页仪表盘** | 统计卡片、工时趋势图、待办事项 |
| **工时填报** | 按日期/项目填报、批量提交审批 |
| **加班提报** | 周末/节假日/工作日加班申请 |
| **周报管理** | 周报编写、关联本周工时、提交审批 |
| **审批中心** | 待审批列表、批量通过/驳回 |
| **报表中心** | 个人/部门/项目报表、图表展示 |
| **系统管理** | 部门/分组/用户/角色/权限/项目 CRUD |

## 项目结构

```
├── server/                  # 后端
│   ├── data/worktime.db     # SQLite 数据库文件（自动创建）
│   ├── src/
│   │   ├── config/          # 数据库 & JWT 配置
│   │   ├── entities/        # 10 个数据实体
│   │   ├── middleware/      # 认证 & 权限 & 错误处理
│   │   ├── routes/          # 7 个 API 路由模块
│   │   ├── services/        # 7 个业务服务
│   │   └── seed.ts          # 种子数据初始化
│   └── .env
├── client/                  # 前端
│   └── src/
│       ├── api/             # API 调用模块
│       ├── components/      # 主布局
│       ├── pages/           # 7 个页面组件
│       ├── stores/          # Zustand 状态管理
│       ├── router/          # 路由配置
│       └── types/           # 类型定义
└── package.json             # Monorepo 配置
```

## 数据库说明

项目使用 **SQLite** 作为数据库，无需安装任何数据库软件。数据库文件位于 `server/data/worktime.db`，首次运行 `npm run seed` 时自动创建。
