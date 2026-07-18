import { getRedis, isRedisReady } from './redis';
import { logger } from '../utils/logger';

/** 默认 TTL（秒）：写路径会主动失效，TTL 仅兜底脏读窗口 */
const DEFAULT_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60);
const inFlightLoads = new Map<string, Promise<unknown>>();

export const CacheTtl = {
  auth: Number(process.env.AUTH_CACHE_TTL_SEC || 60),
  org: Number(process.env.ORG_CACHE_TTL_SEC || 60),
  project: Number(process.env.PROJECT_CACHE_TTL_SEC || 300),
  approvalFlow: Number(process.env.APPROVAL_FLOW_CACHE_TTL_SEC || 300),
  setting: Number(process.env.SETTING_CACHE_TTL_SEC || 300),
};

function key(parts: (string | number)[]): string {
  return `worktime:cache:${parts.join(':')}`;
}

export const CacheKeys = {
  authUser: (userId: number) => key(['auth', 'user', userId]),
  departments: () => key(['org-catalog', 'departments']),
  groups: (departmentId?: number, parentId?: number) => key(['org-catalog', 'groups', departmentId ?? 'all', parentId ?? 'all']),
  groupTree: (departmentId?: number) => key(['org-catalog', 'group-tree', departmentId ?? 'all']),
  activeProjects: () => key(['project-catalog', 'active']),
  allSettings: () => key(['setting', 'all']),
  setting: (k: string) => key(['setting', k]),
  org: (userId: number) => key(['org', userId]),
  projectApproval: (projectId: number) => key(['project', 'approval', projectId]),
  defaultFlow: (type: string) => key(['flow', 'default', type]),
};

export async function invalidateAuthUser(userId: number): Promise<void> {
  await cacheDel(CacheKeys.authUser(userId));
}

export async function invalidateAuthUsers(userIds: number[]): Promise<void> {
  if (!userIds.length) return;
  await cacheDel(...userIds.map((userId) => CacheKeys.authUser(userId)));
}

async function cacheDelPattern(pattern: string): Promise<void> {
  const client = getRedis();
  if (!client?.isReady) return;
  try {
    for await (const found of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const keys = Array.isArray(found) ? found : [found];
      if (keys.length) await client.del(keys);
    }
  } catch (err) {
    logger.warn({ err, pattern }, '[cache] 批量失效失败');
  }
}

export async function invalidateOrgCatalog(): Promise<void> {
  await cacheDelPattern(key(['org-catalog', '*']));
}

export async function invalidateProjectCatalog(): Promise<void> {
  await cacheDel(CacheKeys.activeProjects());
}

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

/** 单进程请求合并：缓存冷启动/过期瞬间，同一 key 只允许一次回源。 */
export async function cacheGetOrLoad<T>(
  cacheKey: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(cacheKey);
  if (cached !== null) return cached;

  const existing = inFlightLoads.get(cacheKey) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = loader()
    .then(async (value) => {
      await cacheSet(cacheKey, value, ttlSec);
      return value;
    })
    .finally(() => inFlightLoads.delete(cacheKey));
  inFlightLoads.set(cacheKey, pending);
  return pending;
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
  await cacheDel(CacheKeys.setting(settingKey), CacheKeys.allSettings());
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
