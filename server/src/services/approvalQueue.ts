import os from 'node:os';
import { createClient, type RedisClientType } from 'redis';
import { getRedis, isRedisReady } from '../config/redis';
import { logger } from '../utils/logger';

const LEGACY_QUEUE_KEY = 'worktime:queue:timesheet-approval';
const STREAM_KEY = 'worktime:stream:timesheet-approval';
const DEAD_LETTER_STREAM_KEY = 'worktime:stream:timesheet-approval:dead';
const RETRY_HASH_KEY = 'worktime:stream:timesheet-approval:retries';
const CONSUMER_GROUP = 'timesheet-approval-workers';
const CLAIM_IDLE_MS = Math.max(5_000, Number(process.env.APPROVAL_CLAIM_IDLE_MS || 30_000));
const MAX_ATTEMPTS = Math.max(1, Math.min(100, Number(process.env.APPROVAL_MAX_ATTEMPTS || 5)));

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

export async function approvalDeadLetterLength(): Promise<number> {
  const client = getRedis();
  if (!client?.isReady) return 0;
  try {
    return await client.xLen(DEAD_LETTER_STREAM_KEY);
  } catch {
    return 0;
  }
}

export function approvalBatchSize(): number {
  const n = parseInt(process.env.APPROVAL_BATCH_SIZE || '20', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 20;
}

type BatchJobHandler = (jobs: TimesheetApprovalJob[]) => Promise<void>;
export type ApprovalQueueStreamEntry = { id: string; message: Record<string, string> };
export type ParsedApprovalQueueEntry = { id: string; job: TimesheetApprovalJob; entry: ApprovalQueueStreamEntry };
type StreamEntry = ApprovalQueueStreamEntry;
type ParsedEntry = ParsedApprovalQueueEntry;

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

export function parseApprovalQueueEntries(entries: StreamEntry[]): { items: ParsedEntry[]; invalidEntries: StreamEntry[] } {
  const items: ParsedEntry[] = [];
  const invalidEntries: StreamEntry[] = [];
  for (const entry of entries) {
    try {
      if (!entry.message?.payload) throw new Error('缺少 payload');
      const job = JSON.parse(entry.message.payload) as TimesheetApprovalJob;
      if (!Number.isInteger(job.targetId) || job.targetId <= 0
        || !Number.isInteger(job.userId) || job.userId <= 0
        || !Number.isInteger(job.projectId) || job.projectId <= 0
        || !Array.isArray(job.recordIds) || !job.recordIds.length
        || job.recordIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error('任务字段无效');
      }
      items.push({ id: entry.id, job, entry });
    } catch (err) {
      invalidEntries.push(entry);
      logger.warn({ err, streamId: entry.id }, '[approval-queue] 任务内容无效，移入死信队列');
    }
  }
  return { items, invalidEntries };
}

async function ackAndDelete(client: RedisClientType, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await client.xAck(STREAM_KEY, CONSUMER_GROUP, ids);
  await client.xDel(STREAM_KEY, ids);
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error || '未知错误').slice(0, 1000);
}

async function moveToDeadLetter(
  client: RedisClientType,
  entry: StreamEntry,
  reason: string,
  attempts: number,
): Promise<void> {
  await client.xAdd(
    DEAD_LETTER_STREAM_KEY,
    '*',
    {
      sourceId: entry.id,
      payload: entry.message?.payload || '',
      reason: reason.slice(0, 1000),
      attempts: String(attempts),
      failedAt: new Date().toISOString(),
    },
    { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 10_000 } },
  );
  await ackAndDelete(client, [entry.id]);
  await client.hDel(RETRY_HASH_KEY, entry.id);
}

/**
 * 先保留批处理吞吐；整批失败时逐条重试，以隔离单个坏任务，避免它拖住同批正常审批。
 * handler 必须像 TimesheetService.processApprovalJobs 一样保证批次事务原子性。
 */
export async function isolateApprovalJobFailures(
  items: ParsedEntry[],
  handler: BatchJobHandler,
): Promise<{ succeeded: ParsedEntry[]; failed: Array<ParsedEntry & { error: unknown }> }> {
  if (!items.length) return { succeeded: [], failed: [] };
  try {
    await handler(items.map((item) => item.job));
    return { succeeded: items, failed: [] };
  } catch (batchError) {
    logger.warn({ err: batchError, n: items.length }, '[approval-queue] 批处理失败，开始逐条隔离');
  }

  const succeeded: ParsedEntry[] = [];
  const failed: Array<ParsedEntry & { error: unknown }> = [];
  for (const item of items) {
    try {
      await handler([item.job]);
      succeeded.push(item);
    } catch (error) {
      failed.push({ ...item, error });
    }
  }
  return { succeeded, failed };
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

        const { items, invalidEntries } = parseApprovalQueueEntries(entries);
        for (const invalid of invalidEntries) {
          await moveToDeadLetter(client, invalid, '任务 JSON 或必填字段无效', 0);
        }
        if (!items.length) continue;

        const outcome = await isolateApprovalJobFailures(items, handler);
        const succeededIds = outcome.succeeded.map((item) => item.id);
        if (succeededIds.length) {
          await ackAndDelete(client, succeededIds);
          await client.hDel(RETRY_HASH_KEY, succeededIds);
        }

        for (const failed of outcome.failed) {
          const attempts = await client.hIncrBy(RETRY_HASH_KEY, failed.id, 1);
          if (attempts >= MAX_ATTEMPTS) {
            await moveToDeadLetter(client, failed.entry, errorMessage(failed.error), attempts);
            logger.error({
              err: failed.error,
              streamId: failed.id,
              targetId: failed.job.targetId,
              attempts,
            }, '[approval-queue] 任务达到最大重试次数，已移入死信队列');
          } else {
            // 不 ACK：任务保留在 PEL，超过 idle 阈值后由任一健康实例重新认领。
            logger.error({
              err: failed.error,
              streamId: failed.id,
              targetId: failed.job.targetId,
              attempts,
              maxAttempts: MAX_ATTEMPTS,
            }, '[approval-queue] 单条任务失败，等待自动重试');
          }
        }
        if (outcome.failed.length) {
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
