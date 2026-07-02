import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

/**
 * 解析 TRUST_PROXY 环境变量为 express 支持的 trust proxy 取值。
 * 支持的输入：
 *   - 纯数字（含 '0'）→ number
 *   - 布尔字符串 'true'/'false' → boolean
 *   - 其它（如 'loopback', '10.0.0.0/8', 'loopback, 10.0.0.0/8'）→ 原样字符串
 */
function parseTrustProxy(value: string): number | boolean | string {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  return trimmed;
}

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接状态
let dbConnected = false;

// 中间件（顺序重要）
// 反向代理后取真实客户端 IP（登录失败计数/限流/审计日志均依赖此设置）。
// trust proxy 取值语义：
//   - 数字 N：信任最近 N 层代理，从 X-Forwarded-For 倒数第 N+1 个取真实 IP
//   - 'loopback' / 'linklocal' / 'uniquelocal'：信任这些网段的代理
//   - 逗号分隔的 IP/CIDR 列表：只信任指定来源
// 部署拓扑示例：
//   - 单层 Nginx：TRUST_PROXY=1（默认）
//   - Cloudflare → Nginx → Node：TRUST_PROXY=2
//   - 直连无代理：TRUST_PROXY=0（不信任任何代理头）
// 配置错误会导致 req.ip 被伪造（设过大）或拿到代理 IP（设过小）。
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY ?? '1'));
// 安全响应头：CSP、X-Frame-Options、X-Content-Type-Options、HSTS 等
// E10：connectSrc 与 CORS allowedOrigins 保持一致，支持跨域部署（server 不托管前端静态资源）
const corsOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // antd 内联样式需要
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", ...corsOrigins],
    },
  },
}));
// HTTP 请求日志（pino-http，结构化）
// E9：脱敏敏感字段，避免 authorization 头/密码泄漏到日志
app.use(pinoHttp({
  logger,
  autoLogging: process.env.NODE_ENV !== 'test',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.oldPassword',
      'req.body.newPassword',
    ],
    censor: '[REDACTED]',
  },
}));
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

// R14：未知 API 路由返回统一 JSON 404（替代 Express 默认的 HTML 404，保持 API 契约一致）
app.use((req, res) => {
  res.status(404).json({ code: 404, message: `路径不存在: ${req.method} ${req.path}` });
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
