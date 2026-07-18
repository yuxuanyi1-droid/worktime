import os from 'node:os';
import { createClient, type RedisClientType } from 'redis';
import { getRedis, isRedisReady } from '../config/redis';
import { logger } from '../utils/logger';

const LEGACY_QUEUE_KEY = 'worktime:queue:timesheet-approval';
const STREAM_KEY = 'worktime:stream:timesheet-approval';
const CONSUMER_GROUP = 'timesheet-approval-workers';
const CLAIM_IDLE_MS = Math.max(5_000, Number(process.env.APPROVAL_CLAIM_IDLE_MS || 30_000));

export type TimesheetApprovalJob = {
  targetId: number;
  recordIds: number[];
  projectId: number;
  userId: number;
  title: string;
};

/** Redis Streams 入队；消息在 worker 成功 ACK 前会保留，可在进程崩溃后恢复。 */
export async function enqueueTimesheetApprovals(jobs: TimesheetApprovalJob[]): Promise<boolean> {
  const client = getRedis();
  if (!client?.isReady || !jobs.length) return false;
  try {
    await Promise.all(jobs.map((job) => client.xAdd(
      STREAM_KEY,
      '*',
      { payload: JSON.stringify(job) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100_000 } },
    )));
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
    return await client.xLen(STREAM_KEY);
  } catch {
    return 0;
  }
}

export function approvalBatchSize(): number {
  const n = parseInt(process.env.APPROVAL_BATCH_SIZE || '20', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 20;
}

type BatchJobHandler = (jobs: TimesheetApprovalJob[]) => Promise<void>;
type StreamEntry = { id: string; message: Record<string, string> };

let workerClient: RedisClientType | null = null;
let workerStop = false;
let workerRunning = false;

async function ensureConsumerGroup(client: RedisClientType): Promise<void> {
  try {
    await client.xGroupCreate(STREAM_KEY, CONSUMER_GROUP, '0', { MKSTREAM: true });
  } catch (err) {
    if (!String((err as Error)?.message || err).includes('BUSYGROUP')) throw err;
  }
}

/** 将旧版 List 中尚未消费的任务无损迁入 Stream，支持滚动升级。 */
async function migrateLegacyQueue(client: RedisClientType): Promise<void> {
  let migrated = 0;
  while (true) {
    const raws = await client.lPopCount(LEGACY_QUEUE_KEY, 100);
    if (!raws?.length) break;
    await Promise.all(raws.map((payload) => client.xAdd(STREAM_KEY, '*', { payload })));
    migrated += raws.length;
  }
  if (migrated) logger.info({ migrated }, '[approval-queue] 旧队列任务已迁移');
}

function parseEntries(entries: StreamEntry[]): { jobs: TimesheetApprovalJob[]; validIds: string[]; invalidIds: string[] } {
  const jobs: TimesheetApprovalJob[] = [];
  const validIds: string[] = [];
  const invalidIds: string[] = [];
  for (const entry of entries) {
    try {
      if (!entry.message?.payload) throw new Error('缺少 payload');
      jobs.push(JSON.parse(entry.message.payload) as TimesheetApprovalJob);
      validIds.push(entry.id);
    } catch (err) {
      invalidIds.push(entry.id);
      logger.warn({ err, streamId: entry.id }, '[approval-queue] 任务 JSON 无效，确认并丢弃');
    }
  }
  return { jobs, validIds, invalidIds };
}

async function ackAndDelete(client: RedisClientType, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await client.xAck(STREAM_KEY, CONSUMER_GROUP, ids);
  await client.xDel(STREAM_KEY, ids);
}

/**
 * 启动 Redis Streams 消费循环。新消息由 consumer group 分发；超过 CLAIM_IDLE_MS
 * 仍未 ACK 的消息会被其他实例自动认领，避免 API/worker 崩溃造成审批任务永久丢失。
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
  const consumer = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  workerStop = false;
  workerRunning = true;
  const client = createClient({ url }) as RedisClientType;
  client.on('error', (err) => logger.warn({ err }, '[approval-queue] worker Redis 错误'));
  await client.connect();
  await ensureConsumerGroup(client);
  await migrateLegacyQueue(client);
  workerClient = client;
  logger.info({ batchSize, consumer, claimIdleMs: CLAIM_IDLE_MS }, '[approval-queue] Streams worker 已启动');

  (async () => {
    while (!workerStop) {
      try {
        const claimed = await client.xAutoClaim(
          STREAM_KEY,
          CONSUMER_GROUP,
          consumer,
          CLAIM_IDLE_MS,
          '0-0',
          { COUNT: batchSize },
        ) as any;
        let entries = (claimed?.messages || []).filter(Boolean) as StreamEntry[];

        if (!entries.length) {
          const streams = await client.xReadGroup(
            CONSUMER_GROUP,
            consumer,
            { key: STREAM_KEY, id: '>' },
            { COUNT: batchSize, BLOCK: 2_000 },
          ) as any;
          entries = (streams?.[0]?.messages || []) as StreamEntry[];
        }
        if (!entries.length) continue;

        const { jobs, validIds, invalidIds } = parseEntries(entries);
        await ackAndDelete(client, invalidIds);
        if (!jobs.length) continue;

        try {
          await handler(jobs);
          await ackAndDelete(client, validIds);
        } catch (err) {
          // 不 ACK：任务留在 PEL，超过 idle 阈值后由任一健康实例重新认领。
          logger.error({ err, n: jobs.length, targetIds: jobs.map((job) => job.targetId) }, '[approval-queue] 批处理失败，等待自动重试');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch (err) {
        if (workerStop) break;
        logger.warn({ err }, '[approval-queue] Streams 消费异常');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    workerRunning = false;
    try {
      if (client.isOpen) await client.quit();
    } catch { /* ignore */ }
    workerClient = null;
    logger.info('[approval-queue] worker 已停止');
  })();
}

export async function stopApprovalQueueWorker(): Promise<void> {
  workerStop = true;
  if (workerClient?.isOpen) {
    try {
      await workerClient.quit();
    } catch { /* ignore */ }
  }
}
