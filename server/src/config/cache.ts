import { getRedis, isRedisReady } from './redis';
import { logger } from '../utils/logger';

/** 默认 TTL（秒）：写路径会主动失效，TTL 仅兜底脏读窗口 */
const DEFAULT_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60);

function key(parts: (string | number)[]): string {
  return `worktime:cache:${parts.join(':')}`;
}

export const CacheKeys = {
  setting: (k: string) => key(['setting', k]),
  org: (userId: number) => key(['org', userId]),
  projectApproval: (projectId: number) => key(['project', 'approval', projectId]),
  defaultFlow: (type: string) => key(['flow', 'default', type]),
};

export async function cacheGet<T>(cacheKey: string): Promise<T | null> {
  const client = getRedis();
  if (!client?.isReady) return null;
  try {
    const raw = await client.get(cacheKey);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, cacheKey }, '[cache] GET 失败');
    return null;
  }
}

export async function cacheSet(cacheKey: string, value: unknown, ttlSec = DEFAULT_TTL_SEC): Promise<void> {
  const client = getRedis();
  if (!client?.isReady) return;
  try {
    const payload = JSON.stringify(value);
    if (ttlSec > 0) {
      await client.set(cacheKey, payload, { EX: ttlSec });
    } else {
      await client.set(cacheKey, payload);
    }
  } catch (err) {
    logger.warn({ err, cacheKey }, '[cache] SET 失败');
  }
}

export async function cacheDel(...cacheKeys: string[]): Promise<void> {
  const client = getRedis();
  if (!client?.isReady || !cacheKeys.length) return;
  try {
    await client.del(cacheKeys);
  } catch (err) {
    logger.warn({ err, cacheKeys }, '[cache] DEL 失败');
  }
}

export async function invalidateSetting(settingKey: string): Promise<void> {
  await cacheDel(CacheKeys.setting(settingKey));
}

export async function invalidateOrgSnapshot(userId: number): Promise<void> {
  await cacheDel(CacheKeys.org(userId));
}

export async function invalidateProjectApproval(projectId: number): Promise<void> {
  await cacheDel(CacheKeys.projectApproval(projectId));
}

export async function invalidateDefaultFlow(type: string): Promise<void> {
  await cacheDel(CacheKeys.defaultFlow(type));
}

/** 审批流变更时清掉常见 targetType 的默认流缓存 */
export async function invalidateAllDefaultFlows(): Promise<void> {
  await cacheDel(
    CacheKeys.defaultFlow('timesheet'),
    CacheKeys.defaultFlow('overtime'),
    CacheKeys.defaultFlow('weekly_report'),
  );
}

export function cacheEnabled(): boolean {
  return isRedisReady();
}
