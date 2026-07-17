import { createClient, type RedisClientType } from 'redis';
import { getRedis, isRedisReady } from '../config/redis';
import { logger } from '../utils/logger';

const QUEUE_KEY = 'worktime:queue:timesheet-approval';

export type TimesheetApprovalJob = {
  targetId: number;
  recordIds: number[];
  projectId: number;
  userId: number;
  title: string;
};

/** 入队；Redis 不可用返回 false，由调用方降级 */
export async function enqueueTimesheetApprovals(jobs: TimesheetApprovalJob[]): Promise<boolean> {
  const client = getRedis();
  if (!client?.isReady || !jobs.length) return false;
  try {
    const payloads = jobs.map((j) => JSON.stringify(j));
    await client.rPush(QUEUE_KEY, payloads);
    return true;
  } catch (err) {
    logger.warn({ err, n: jobs.length }, '[approval-queue] 入队失败');
    return false;
  }
}

export async function approvalQueueLength(): Promise<number> {
  const client = getRedis();
  if (!client?.isReady) return 0;
  try {
    return await client.lLen(QUEUE_KEY);
  } catch {
    return 0;
  }
}

export function approvalBatchSize(): number {
  const n = parseInt(process.env.APPROVAL_BATCH_SIZE || '20', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 20;
}

type BatchJobHandler = (jobs: TimesheetApprovalJob[]) => Promise<void>;

let workerClient: RedisClientType | null = null;
let workerStop = false;
let workerRunning = false;

function parseJobs(raws: string[]): { jobs: TimesheetApprovalJob[]; raws: string[] } {
  const jobs: TimesheetApprovalJob[] = [];
  const okRaws: string[] = [];
  for (const raw of raws) {
    try {
      jobs.push(JSON.parse(raw) as TimesheetApprovalJob);
      okRaws.push(raw);
    } catch (err) {
      logger.warn({ err, raw }, '[approval-queue] 任务 JSON 无效，丢弃');
    }
  }
  return { jobs, raws: okRaws };
}

/**
 * 启动阻塞批量消费循环（独立 Redis 连接）。
 * 先 BRPOP 取 1 条，再 LPOP 补齐到 batchSize，整批交给 handler。
 */
export async function startApprovalQueueWorker(handler: BatchJobHandler): Promise<void> {
  if (workerRunning) return;
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) {
    logger.info('[approval-queue] 无 REDIS_URL，跳过 worker');
    return;
  }
  if (!isRedisReady()) {
    logger.warn('[approval-queue] Redis 未就绪，跳过 worker');
    return;
  }

  const batchSize = approvalBatchSize();
  workerStop = false;
  workerRunning = true;
  const c = createClient({ url }) as RedisClientType;
  c.on('error', (err) => logger.warn({ err }, '[approval-queue] worker Redis 错误'));
  await c.connect();
  workerClient = c;
  logger.info({ batchSize }, '[approval-queue] worker 已启动（批量）');

  (async () => {
    while (!workerStop) {
      try {
        const first = await c.brPop(QUEUE_KEY, 2);
        if (!first) continue;

        const raws: string[] = [first.element];
        if (batchSize > 1) {
          // Redis 6.2+：一次弹出多条；失败则逐条 LPOP
          try {
            const more = await c.lPopCount(QUEUE_KEY, batchSize - 1);
            if (more?.length) raws.push(...more);
          } catch {
            for (let i = 0; i < batchSize - 1; i++) {
              const one = await c.lPop(QUEUE_KEY);
              if (!one) break;
              raws.push(one);
            }
          }
        }

        const { jobs, raws: okRaws } = parseJobs(raws);
        if (!jobs.length) continue;

        try {
          await handler(jobs);
        } catch (err) {
          logger.error({ err, n: jobs.length, targetIds: jobs.map((j) => j.targetId) }, '[approval-queue] 批处理失败，重新入队');
          try {
            await c.rPush(QUEUE_KEY, okRaws);
          } catch (e2) {
            logger.error({ err: e2 }, '[approval-queue] 重新入队失败');
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (err) {
        if (workerStop) break;
        logger.warn({ err }, '[approval-queue] BRPOP 异常');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    workerRunning = false;
    try {
      await c.quit();
    } catch { /* ignore */ }
    workerClient = null;
    logger.info('[approval-queue] worker 已停止');
  })();
}

export async function stopApprovalQueueWorker(): Promise<void> {
  workerStop = true;
  if (workerClient?.isReady) {
    try {
      await workerClient.quit();
    } catch { /* ignore */ }
  }
}
