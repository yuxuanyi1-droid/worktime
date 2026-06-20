import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';
import { AppDataSource, ensureSchema } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import { globalLimiter, loginLimiter } from './middleware/security';
import { metricsMiddleware, metricsHandler } from './middleware/metrics';
import { logger } from './utils/logger';
import { authRoutes } from './routes/auth';
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接状态
let dbConnected = false;

// 中间件（顺序重要）
// 反向代理后取真实 IP（限流依赖此设置）
app.set('trust proxy', 1);
// HTTP 请求日志（pino-http，结构化）
app.use(pinoHttp({ logger, autoLogging: process.env.NODE_ENV !== 'test' }));
// Prometheus 指标采集
app.use(metricsMiddleware);
// CORS origin 从环境变量读取（逗号分隔），生产环境应锁定为真实域名
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
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
app.use('/api/', globalLimiter);

// 数据库状态检查中间件（仅对 API 路由生效）
app.use('/api/v1', (req, res, next) => {
  if (!dbConnected) {
    return res.status(503).json({
      code: 503,
      message: '数据库未连接，请检查数据库配置和服务状态',
    });
  }
  next();
});

// 登录接口额外限流
app.use('/api/v1/auth/login', loginLimiter);

// 路由
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/system', systemRoutes);
app.use('/api/v1/timesheets', timesheetRoutes);
app.use('/api/v1/overtime', overtimeRoutes);
app.use('/api/v1/weekly-reports', weeklyReportRoutes);
app.use('/api/v1/approvals', approvalRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/audit-logs', auditRoutes);
app.use('/api/v1/announcements', announcementRoutes);
app.use('/api/v1/permission-requests', permissionRequestRoutes);

// Prometheus 指标端点（生产应通过 METRICS_TOKEN 环境变量加 Bearer 校验）
app.get('/api/metrics', async (req, res) => {
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
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    dbConnected,
    timestamp: new Date().toISOString(),
  });
});

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
