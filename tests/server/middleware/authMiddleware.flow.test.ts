import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  getRepository: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  permissionSnapshot: vi.fn(),
  loadedPermissions: vi.fn(),
}));

vi.mock('jsonwebtoken', () => ({
  default: { verify: mocks.verify },
}));

vi.mock('@server/config/database', () => ({
  AppDataSource: { getRepository: mocks.getRepository },
}));

vi.mock('@server/config/cache', () => ({
  CacheKeys: { authUser: (id: number) => `auth:${id}` },
  CacheTtl: { auth: 300 },
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));

vi.mock('@server/services/accessPolicyService', () => ({
  AccessPolicyService: class {
    getPermissionSnapshotForLoadedUser = mocks.permissionSnapshot;
    getPermissionCodesForLoadedUser = mocks.loadedPermissions;
  },
}));

const { authMiddleware, hashPat } = await import('@server/middleware/auth');
const { PERMISSION_MODEL_VERSION } = await import('@server/config/permissionDefinitions');

function createContext(token?: string, options: { method?: string; url?: string } = {}) {
  const req: any = {
    headers: token === undefined ? {} : { authorization: token },
    method: options.method ?? 'GET',
    originalUrl: options.url ?? '/api/v1/reports/dashboard',
  };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn(function status(code: number) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function json(body: unknown) {
      res.body = body;
      return res;
    }),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('authMiddleware 完整认证分支', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.permissionSnapshot.mockResolvedValue({ permissions: new Set(['timesheet:view:self']), refreshAt: null });
    mocks.loadedPermissions.mockResolvedValue(new Set(['report:view:self']));
  });

  it.each([
    [undefined, '未提供认证Token'],
    ['Basic abc', '未提供认证Token'],
  ])('拒绝缺失或非 Bearer 认证头', async (header, message) => {
    const { req, res, next } = createContext(header);
    await authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe(message);
    expect(next).not.toHaveBeenCalled();
  });

  it('使用版本匹配且授权未到切换点的缓存用户，不重复访问数据库', async () => {
    mocks.verify.mockReturnValue({ id: 7, v: 2 });
    mocks.cacheGet.mockResolvedValue({
      id: 7, username: 'cached', realName: '缓存用户', roles: ['employee'],
      permissions: ['timesheet:view:self'], tokenVersion: 2,
      permissionModelVersion: PERMISSION_MODEL_VERSION,
      permissionsRefreshAt: Date.now() + 60_000,
    });
    const { req, res, next } = createContext('Bearer jwt-token');

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.authMethod).toBe('jwt');
    expect(req.userPermissions).toEqual(new Set(['timesheet:view:self']));
    expect(mocks.getRepository).not.toHaveBeenCalled();
  });

  it('缓存 tokenVersion 不匹配时立即使旧 JWT 失效', async () => {
    mocks.verify.mockReturnValue({ id: 7, v: 1 });
    mocks.cacheGet.mockResolvedValue({
      id: 7, username: 'cached', realName: '缓存用户', roles: [], permissions: [], tokenVersion: 2,
      permissionModelVersion: PERMISSION_MODEL_VERSION, permissionsRefreshAt: null,
    });
    const { req, res, next } = createContext('Bearer jwt-token');

    await authMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('登录已失效，请重新登录');
    expect(next).not.toHaveBeenCalled();
  });

  it('授权缓存到切换点后重新加载用户及权限，并写回精确刷新时间', async () => {
    mocks.verify.mockReturnValue({ id: 8, v: 3 });
    mocks.cacheGet.mockResolvedValue({
      id: 8, username: 'old', realName: '旧缓存', roles: [], permissions: ['old'], tokenVersion: 3,
      permissionModelVersion: PERMISSION_MODEL_VERSION,
      permissionsRefreshAt: Date.now() - 1,
    });
    const user = {
      id: 8, username: 'fresh', realName: '新用户', status: 1, tokenVersion: 3,
      roles: [{ name: 'employee', permissions: [] }],
    };
    mocks.getRepository.mockReturnValue({ findOne: vi.fn().mockResolvedValue(user) });
    mocks.permissionSnapshot.mockResolvedValue({
      permissions: new Set(['report:view:self']), refreshAt: 1_800_000_000_000,
    });
    const { req, res, next } = createContext('Bearer jwt-token');

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user.username).toBe('fresh');
    expect(mocks.cacheSet).toHaveBeenCalledWith('auth:8', expect.objectContaining({
      permissions: ['report:view:self'],
      permissionsRefreshAt: 1_800_000_000_000,
      permissionModelVersion: PERMISSION_MODEL_VERSION,
    }), 300);
  });

  it('数据库用户被禁用或 tokenVersion 已变化时拒绝 JWT', async () => {
    mocks.verify.mockReturnValue({ id: 9, v: 1 });
    const findOne = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 9, username: 'user', realName: '用户', status: 1, tokenVersion: 2, roles: [],
      });
    mocks.getRepository.mockReturnValue({ findOne });

    const missing = createContext('Bearer jwt-token');
    await authMiddleware(missing.req, missing.res, missing.next);
    expect(missing.res.body.message).toBe('用户不存在或已禁用');

    const stale = createContext('Bearer jwt-token');
    await authMiddleware(stale.req, stale.res, stale.next);
    expect(stale.res.body.message).toBe('登录已失效，请重新登录');
  });

  it('AI 内部令牌只允许读取白名单资源', async () => {
    mocks.verify.mockReturnValue({ id: 5, v: 0, purpose: 'agent' });
    const forbidden = createContext('Bearer agent-jwt', { method: 'POST', url: '/api/v1/timesheets/submit' });
    await authMiddleware(forbidden.req, forbidden.res, forbidden.next);
    expect(forbidden.res.statusCode).toBe(403);
    expect(forbidden.res.body.message).toBe('AI 内部令牌无权访问该接口');
    expect(mocks.cacheGet).not.toHaveBeenCalled();

    mocks.cacheGet.mockResolvedValue({
      id: 5, username: 'agent-user', realName: 'AI 用户', roles: [], permissions: [], tokenVersion: 0,
      permissionModelVersion: PERMISSION_MODEL_VERSION, permissionsRefreshAt: null,
    });
    const allowed = createContext('Bearer agent-jwt', { url: '/api/v1/timesheets/my' });
    await authMiddleware(allowed.req, allowed.res, allowed.next);
    expect(allowed.next).toHaveBeenCalledOnce();
    expect(allowed.req.authMethod).toBe('agent');
  });

  it('PAT 不存在、过期或所属用户禁用时分别返回明确错误', async () => {
    const findOne = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ expiresAt: new Date(Date.now() - 1), user: { status: 1 } })
      .mockResolvedValueOnce({ expiresAt: null, user: { status: 0 } });
    mocks.getRepository.mockReturnValue({ findOne, update: vi.fn() });

    for (const expected of ['访问令牌无效', '访问令牌已过期', '令牌所属用户不存在或已禁用']) {
      const context = createContext('Bearer wpat_secret');
      await authMiddleware(context.req, context.res, context.next);
      expect(context.res.body.message).toBe(expected);
      expect(context.next).not.toHaveBeenCalled();
    }
  });

  it('PAT 到达过期时间边界后立即失效', async () => {
    const now = new Date('2026-07-22T12:00:00.000Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    mocks.getRepository.mockReturnValue({
      findOne: vi.fn().mockResolvedValue({ expiresAt: new Date(now), user: { status: 1 } }),
      update: vi.fn(),
    });
    const context = createContext('Bearer wpat_boundary');

    await authMiddleware(context.req, context.res, context.next);

    expect(context.res.statusCode).toBe(401);
    expect(context.res.body.message).toBe('访问令牌已过期');
    expect(context.next).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('有效 PAT 只存哈希查询，挂载用户权限并节流 lastUsedAt 写入', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const findOne = vi.fn().mockResolvedValue({
      id: 12,
      lastUsedAt: new Date(Date.now() - 10 * 60_000),
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 3, username: 'pat-user', realName: 'PAT 用户', status: 1,
        roles: [{ name: 'employee', permissions: [] }],
      },
    });
    mocks.getRepository.mockReturnValue({ findOne, update });
    const { req, res, next } = createContext('Bearer wpat_plain-secret');

    await authMiddleware(req, res, next);

    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { tokenHash: hashPat('wpat_plain-secret') },
    }));
    expect(update).toHaveBeenCalledWith(12, { lastUsedAt: expect.any(Date) });
    expect(req.authMethod).toBe('pat');
    expect(req.userPermissions).toEqual(new Set(['report:view:self']));
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('JWT 验签异常统一返回无效或过期，不泄露底层错误', async () => {
    mocks.verify.mockImplementation(() => { throw new Error('signature details'); });
    const { req, res, next } = createContext('Bearer broken');
    await authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ code: 401, message: 'Token无效或已过期' });
    expect(next).not.toHaveBeenCalled();
  });
});
