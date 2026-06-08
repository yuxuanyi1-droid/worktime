import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { AppDataSource } from './config/database';
import { errorHandler } from './middleware/errorHandler';
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接状态
let dbConnected = false;

// 中间件
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
  .then(() => {
    dbConnected = true;
    console.log('✅ 数据库连接成功');
    console.log(`📋 已注册实体: ${AppDataSource.entityMetadatas.map(e => e.name).join(', ')}`);
    app.listen(PORT, () => {
      console.log(`🚀 服务端运行在 http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ 数据库连接失败:', error.message);
    console.error('   请检查 server/.env 中的数据库配置');
    // 即使数据库连接失败也启动服务，方便调试
    app.listen(PORT, () => {
      console.log(`⚠️  服务端运行在 http://localhost:${PORT} (数据库未连接)`);
    });
  });

export default app;
