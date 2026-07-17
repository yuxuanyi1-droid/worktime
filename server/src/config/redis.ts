import { createClient, type RedisClientType } from 'redis';
import { logger } from '../utils/logger';

/**
 * 可选 Redis 客户端。未配置 REDIS_URL 时保持 null，限流/序号回退内存或 DB。
 */
let client: RedisClientType | null = null;

export function getRedis(): RedisClientType | null {
  return client;
}

export function isRedisReady(): boolean {
  return !!client?.isReady;
}

/** 连接 Redis；失败不抛错（调试/降级为无 Redis） */
export async function initRedis(): Promise<boolean> {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) {
    logger.info('[redis] 未配置 REDIS_URL，跳过');
    return false;
  }
  try {
    const c = createClient({ url }) as RedisClientType;
    c.on('error', (err) => {
      logger.warn({ err }, '[redis] 客户端错误');
    });
    await c.connect();
    client = c;
    logger.info({ url: url.replace(/\/\/.*@/, '//***@') }, '[redis] 已连接');
    return true;
  } catch (err) {
    logger.warn({ err }, '[redis] 连接失败，将回退内存限流 / DB 序号');
    client = null;
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    // ignore
  }
  client = null;
}

/** 原子自增 submissionGroupId；Redis 不可用时返回 null，由调用方回退 DB */
export async function redisNextSubmissionGroupId(): Promise<number | null> {
  const ids = await redisNextSubmissionGroupIds(1);
  return ids?.[0] ?? null;
}

/** 一次分配 count 个连续序号（INCRBY），减少多项目提交时的往返 */
export async function redisNextSubmissionGroupIds(count: number): Promise<number[] | null> {
  if (!client?.isReady || count <= 0) return null;
  try {
    const last = await client.incrBy('worktime:submissionGroupId', count);
    const first = last - count + 1;
    return Array.from({ length: count }, (_, i) => first + i);
  } catch (err) {
    logger.warn({ err, count }, '[redis] INCRBY submissionGroupId 失败');
    return null;
  }
}

/**
 * 启动时用 DB 最大 submissionGroupId 校准 Redis，避免重启后序号回绕撞车。
 */
export async function syncSubmissionGroupIdFromDb(maxId: number): Promise<void> {
  if (!client?.isReady) return;
  try {
    const current = Number((await client.get('worktime:submissionGroupId')) || 0);
    if (maxId > current) {
      await client.set('worktime:submissionGroupId', String(maxId));
      logger.info({ maxId }, '[redis] submissionGroupId 已从 DB 校准');
    }
  } catch (err) {
    logger.warn({ err }, '[redis] 校准 submissionGroupId 失败');
  }
}
