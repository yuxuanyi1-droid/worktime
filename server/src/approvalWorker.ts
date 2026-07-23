/**
 * 独立审批队列 worker（批量消费）。
 * 默认场景下 API 已内嵌 worker；仅当 APPROVAL_WORKER=0 时需要本进程。
 *
 * 用法：
 *   cd server && APPROVAL_WORKER=0 npm start   # API 仅入队
 *   npm run worker:approval                   # 独立消费
 */
import './config/env';
import path from 'node:path';
import { AppDataSource } from './config/database';
import { initRedis, closeRedis } from './config/redis';
import {
  startApprovalQueueWorker,
  stopApprovalQueueWorker,
  approvalBatchSize,
} from './services/approvalQueue';
import { TimesheetService } from './services/timesheetService';
import { logger } from './utils/logger';

let shuttingDown = false;

export async function startApprovalWorker() {
  shuttingDown = false;
  await AppDataSource.initialize();
  const redisOk = await initRedis();
  if (!redisOk) {
    await AppDataSource.destroy().catch(() => undefined);
    throw new Error('[approval-worker] Redis 不可用');
  }

  await startApprovalQueueWorker(async (jobs) => {
    await new TimesheetService().processApprovalJobs(jobs);
  });

  logger.info({ batchSize: approvalBatchSize() }, '[approval-worker] 就绪');
}

export async function stopApprovalWorker(exitProcess = true) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('[approval-worker] 正在退出…');
  await stopApprovalQueueWorker().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  if (AppDataSource.isInitialized) await AppDataSource.destroy().catch(() => undefined);
  if (exitProcess) process.exit(0);
}

export function registerApprovalWorkerSignals(target: Pick<NodeJS.Process, 'once'> = process) {
  target.once('SIGINT', () => { void stopApprovalWorker(); });
  target.once('SIGTERM', () => { void stopApprovalWorker(); });
}

if (process.env.WORKTIME_DISABLE_AUTO_START !== '1'
  && path.resolve(process.argv[1] || '') === path.resolve(__filename)) {
  registerApprovalWorkerSignals();
  void startApprovalWorker().catch((err) => {
    logger.error({ err }, '[approval-worker] 启动失败');
    process.exit(1);
  });
}
