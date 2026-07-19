import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import type { Server } from 'node:http';
import './config/env'; // 加载根 .env（端口）+ server/.env（业务配置）
import pinoHttp from 'pino-http';
import { AppDataSource, ensureSchema, databaseType } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import { globalLimiter, loginLimiter, oidcCallbackLimiter, agentLimiter, activateRateLimiters } from './middleware/security';
import { closeRedis, initRedis, syncSubmissionGroupIdFromDb } from './config/redis';
import { startApprovalQueueWorker, stopApprovalQueueWorker } from './services/approvalQueue';
import { TimesheetService } from './services/timesheetService';
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
import { patRoutes } from './routes/pat';
import { agentRoutes } from './routes/agent';
import { ensurePiModelsJson } from './config/ai';
import { preloadPi } from './ai/agentRunner';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
// PORT 统一在根 .env 配置；Number 化避免字符串端口传入 listen
const PORT = Number(process.env.PORT) || 3000;
// 生产多实例默认仅监听本机，由 Caddy/Nginx 统一对外；容器内可显式设为 0.0.0.0。
const API_HOST = (process.env.API_HOST || (isProduction ? '127.0.0.1' : '0.0.0.0')).trim();
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
let httpServer: Server | null = null;
let shuttingDown = false;

// 中间件（顺序重要）
// 反向代理后取真实 IP（限流依赖此设置）
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  // 开发期需要 Vite 的动态脚本；生产静态站点使用严格同源策略。
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
// HTTP 请求日志（pino-http，结构化）。错误请求全部保留；成功请求可按比例采样，
// 避免高峰期同步生成大量无诊断价值的日志。开发环境默认全量，生产默认采样 1%。
const successLogSampleRate = (() => {
  const fallback = process.env.NODE_ENV === 'production' ? 0.01 : 1;
  const parsed = Number(process.env.HTTP_SUCCESS_LOG_SAMPLE_RATE ?? fallback);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
})();
let successLogAccumulator = 0;
app.use(pinoHttp({ logger, autoLogging: false }));
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const details = {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTime: Number(elapsedMs.toFixed(1)),
    };
    if (res.statusCode >= 500) {
      req.log.error(details, '请求失败');
    } else if (res.statusCode >= 400) {
      req.log.warn(details, '请求被拒绝');
    } else if (successLogSampleRate >= 1) {
      req.log.info(details, '请求完成（采样）');
    } else if (successLogSampleRate > 0) {
      // 累加器能稳定逼近任意采样比例，也避免每个请求调用随机数生成器。
      successLogAccumulator += successLogSampleRate;
      if (successLogAccumulator >= 1) {
        successLogAccumulator -= 1;
        req.log.info(details, '请求完成（采样）');
      }
    }
  });
  next();
});
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
const bodyLimit = process.env.HTTP_BODY_LIMIT || '1mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

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
// AI 聊天限流（每次对话触发 LLM 调用，成本与延时较高）
app.use(`${v1Base}/agent/chat`, agentLimiter);

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
app.use(`${v1Base}/pats`, patRoutes);
app.use(`${v1Base}/agent`, agentRoutes);

// Prometheus 指标端点（生产应通过 METRICS_TOKEN 环境变量加 Bearer 校验）
app.get(`${apiBase}/metrics`, async (req, res) => {
  const metricsToken = process.env.METRICS_TOKEN;
  if (isProduction && !metricsToken) {
    return res.status(404).json({ code: 404, message: 'Not Found' });
  }
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
    const redisOk = await initRedis();
    activateRateLimiters();
    if (redisOk) {
      const maxRow = await AppDataSource.query(
        `SELECT COALESCE(MAX("submissionGroupId"), 0) AS "maxId" FROM timesheets`,
      ).catch(() => [{ maxId: 0 }]);
      const maxId = Number(maxRow?.[0]?.maxId ?? 0);
      await syncSubmissionGroupIdFromDb(maxId);
      // 默认内嵌审批 worker（同机提交吞吐更好）；设 APPROVAL_WORKER=0 则仅入队，由独立进程消费
      if (process.env.APPROVAL_WORKER !== '0') {
        await startApprovalQueueWorker(async (jobs) => {
          await new TimesheetService().processApprovalJobs(jobs);
        });
        logger.info({ batchSize: process.env.APPROVAL_BATCH_SIZE || '20' }, '[approval-queue] API 内嵌 worker');
      } else {
        logger.info('[approval-queue] API 仅入队（APPROVAL_WORKER=0），请启动 npm run worker:approval');
      }
    }
    logger.info({ dbType: databaseType, redis: redisOk }, '存储后端就绪');
    // 生成 pi agent 的 models.json（AI 未配置则跳过，不影响启动）
    ensurePiModelsJson();
    // 预启动 pi worker：pi 是大型 ESM 包，在已加载 CJS 模块的主线程里动态 import 会死锁事件循环，
    // 必须放进 worker 线程。服务启动时预创建 worker 并 import pi，避免首次请求时阻塞。
    preloadPi();
    dbConnected = true;
    logger.info('数据库连接成功');
    logger.info({ entities: AppDataSource.entityMetadatas.map(e => e.name) }, '已注册实体');
    httpServer = app.listen(PORT, API_HOST, () => {
      logger.info({ host: API_HOST, port: PORT }, '服务端已启动');
    });
  })
  .catch((error) => {
    logger.error({ err: error }, '数据库连接失败，请检查根 .env 中的数据库配置');
    // 即使数据库连接失败也启动服务，方便调试
    initRedis().finally(() => activateRateLimiters());
    httpServer = app.listen(PORT, API_HOST, () => {
      logger.warn({ host: API_HOST, port: PORT }, '服务端已启动（数据库未连接）');
    });
  });

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  dbConnected = false;
  logger.info({ signal }, '服务端开始优雅退出');

  httpServer?.closeIdleConnections?.();
  const drained = new Promise<void>((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
  });
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    timer.unref();
  });
  await Promise.race([drained, timeout]);

  await stopApprovalQueueWorker().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy().catch(() => undefined);
  }
  logger.info({ signal }, '服务端已安全退出');
  process.exit(0);
}

process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

export default app;
