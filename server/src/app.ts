import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import path from 'path';
import './config/env'; // 加载根 .env（端口）+ server/.env（业务配置）
import pinoHttp from 'pino-http';
import { AppDataSource, ensureSchema } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import { globalLimiter, loginLimiter, oidcCallbackLimiter } from './middleware/security';
import { metricsMiddleware, metricsHandler } from './middleware/metrics';
import { logger } from './utils/logger';
import { authRoutes } from './routes/auth';
import { oidcRoutes } from './routes/oidc';
import { systemRoutes } from './routes/system';
import { timesheetRoutes } from './routes/timesheet';
import { overtimeRoutes } from './routes/overtime';
import { weeklyReportRoutes } from './routes/weeklyReport';
import { approvalRoutes } from './routes/approval';
import { reportRoutes } from './routes/report';
import { notificationRoutes } from './routes/notification';
import { auditRoutes } from './routes/audit';
import { announcementRoutes } from './routes/announcement';
import { permissionRequestRoutes } from './routes/permissionRequest';

const app = express();
// PORT 统一在根 .env 配置；Number 化避免字符串端口传入 listen
const PORT = Number(process.env.PORT) || 3000;
// 前端端口联动：未配置 ALLOWED_ORIGINS 时按 CLIENT_PORT 自动生成默认白名单
const clientPort = process.env.CLIENT_PORT || '5173';

// 子路径部署前缀（根 .env 的 BASE_PATH，如 /worktime）。
// 规范化：剥尾部斜杠；仅允许空字符串或以 / 开头，否则告警回落为空（根路径部署）。
const BASE_PATH = (() => {
  const raw = (process.env.BASE_PATH || '').trim().replace(/\/+$/, '');
  if (raw && !raw.startsWith('/')) {
    logger.warn(`BASE_PATH="${raw}" 必须以 / 开头，已忽略并使用根路径部署`);
    return '';
  }
  return raw;
})();
// 路由前缀：空 = /api、/api/v1；子路径 = /worktime/api、/worktime/api/v1
const apiBase = `${BASE_PATH}/api`;
const v1Base = `${BASE_PATH}/api/v1`;

// 数据库连接状态
let dbConnected = false;

// 中间件（顺序重要）
// 反向代理后取真实 IP（限流依赖此设置）
app.set('trust proxy', 1);
// HTTP 请求日志（pino-http，结构化）
app.use(pinoHttp({ logger, autoLogging: process.env.NODE_ENV !== 'test' }));
// Prometheus 指标采集
app.use(metricsMiddleware);
// CORS origin 从环境变量读取（逗号分隔），生产环境应锁定为真实域名。
// 未显式配置时按 CLIENT_PORT（根 .env）自动派生默认白名单。
const allowedOrigins = (process.env.ALLOWED_ORIGINS || `http://localhost:${clientPort},http://127.0.0.1:${clientPort}`)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 全局限流（所有路由）
app.use(`${apiBase}/`, globalLimiter);

// 数据库状态检查中间件（仅对 API 路由生效）
app.use(v1Base, (req, res, next) => {
  if (!dbConnected) {
    return res.status(503).json({
      code: 503,
      message: '数据库未连接，请检查数据库配置和服务状态',
    });
  }
  next();
});

// 登录接口额外限流
app.use(`${v1Base}/auth/login`, loginLimiter);
// OIDC 回调限流（换 token 的敏感端点，比通用接口更严格）
app.use(`${v1Base}/auth/oidc/callback`, oidcCallbackLimiter);

// 路由
app.use(`${v1Base}/auth`, authRoutes);
// OIDC 路由挂在 /auth/oidc 下（providers 为公开端点，其余需鉴权由路由内部控制）
app.use(`${v1Base}/auth/oidc`, oidcRoutes);
app.use(`${v1Base}/system`, systemRoutes);
app.use(`${v1Base}/timesheets`, timesheetRoutes);
app.use(`${v1Base}/overtime`, overtimeRoutes);
app.use(`${v1Base}/weekly-reports`, weeklyReportRoutes);
app.use(`${v1Base}/approvals`, approvalRoutes);
app.use(`${v1Base}/reports`, reportRoutes);
app.use(`${v1Base}/notifications`, notificationRoutes);
app.use(`${v1Base}/audit-logs`, auditRoutes);
app.use(`${v1Base}/announcements`, announcementRoutes);
app.use(`${v1Base}/permission-requests`, permissionRequestRoutes);

// Prometheus 指标端点（生产应通过 METRICS_TOKEN 环境变量加 Bearer 校验）
app.get(`${apiBase}/metrics`, async (req, res) => {
  const metricsToken = process.env.METRICS_TOKEN;
  if (metricsToken) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${metricsToken}`) {
      return res.status(401).json({ code: 401, message: 'Unauthorized' });
    }
  }
  await metricsHandler(req, res);
});

// 健康检查（包含数据库状态）
app.get(`${apiBase}/health`, (req, res) => {
  res.json({
    status: 'ok',
    dbConnected,
    timestamp: new Date().toISOString(),
  });
});

// 生产单服务部署：后端同时伺服前端 SPA 静态产物（client/dist）。
// 支持根路径（BASE_PATH 为空）和子路径（BASE_PATH 非空）两种部署方式。
// dist 由 `npm run build` 产出（可选 BASE_PATH=xxx 控制子路径）。
// 注意：开发期（NODE_ENV != production）不挂载静态文件，仍用 vite dev server。
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  const distDir = path.resolve(__dirname, '../../client/dist');
  const mountPath = `${BASE_PATH}/`;
  // 静态资源（如 /assets/... 或 /worktime/assets/...）
  app.use(mountPath, express.static(distDir, { index: false }));
  // 非 API 的请求 fallback 到 index.html（SPA 路由由前端处理）
  app.get(`${BASE_PATH}/*`, (req, res, next) => {
    if (req.path.startsWith(apiBase)) return next(); // API 请求不走 SPA
    res.sendFile(path.join(distDir, 'index.html'));
  });
  if (BASE_PATH) {
    logger.info(`子路径部署：前端静态产物来自 ${distDir}，挂载于 ${BASE_PATH}/`);
  } else {
    // 根路径部署时也需要拦截根路径
    app.get('/', (req, res, next) => {
      if (req.path.startsWith(apiBase)) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
    logger.info(`根路径部署：前端静态产物来自 ${distDir}，前后端同端口（${PORT}）`);
  }
}

// 错误处理
app.use(errorHandler);

// 启动服务
AppDataSource.initialize()
  .then(async () => {
    await ensureSchema();
    dbConnected = true;
    logger.info('数据库连接成功');
    logger.info({ entities: AppDataSource.entityMetadatas.map(e => e.name) }, '已注册实体');
    app.listen(PORT, () => {
      logger.info(`服务端运行在 http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    logger.error({ err: error }, '数据库连接失败，请检查 server/.env 中的数据库配置');
    // 即使数据库连接失败也启动服务，方便调试
    app.listen(PORT, () => {
      logger.warn(`服务端运行在 http://localhost:${PORT} (数据库未连接)`);
    });
  });

export default app;
