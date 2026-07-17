/**
 * 独立审批队列 worker（批量消费）。
 * 默认场景下 API 已内嵌 worker；仅当 APPROVAL_WORKER=0 时需要本进程。
 *
 * 用法：
 *   cd server && APPROVAL_WORKER=0 npm start   # API 仅入队
 *   npm run worker:approval                   # 独立消费
 */
import './config/env';
import { AppDataSource } from './config/database';
import { initRedis, closeRedis } from './config/redis';
import {
  startApprovalQueueWorker,
  stopApprovalQueueWorker,
  approvalBatchSize,
} from './services/approvalQueue';
import { TimesheetService } from './services/timesheetService';
import { logger } from './utils/logger';

async function main() {
  await AppDataSource.initialize();
  const redisOk = await initRedis();
  if (!redisOk) {
    logger.error('[approval-worker] Redis 不可用，退出');
    process.exit(1);
  }

  await startApprovalQueueWorker(async (jobs) => {
    await new TimesheetService().processApprovalJobs(jobs);
  });

  logger.info({ batchSize: approvalBatchSize() }, '[approval-worker] 就绪');

  const shutdown = async () => {
    logger.info('[approval-worker] 正在退出…');
    await stopApprovalQueueWorker();
    await closeRedis();
    await AppDataSource.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, '[approval-worker] 启动失败');
  process.exit(1);
});
