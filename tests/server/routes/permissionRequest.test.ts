import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuditService } from '@server/services/auditService';
import { PermissionGovernanceService } from '@server/services/permissionGovernanceService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 3, username: 'applicant', realName: '申请人', roles: ['employee'] };
    req.userPermissions = new Set([
      'permission_request:access', 'permission_request:view:self',
      'permission_request:view:all', 'permission_request:create', 'permission_grant:manage',
    ]);
    next();
  },
}));

const { permissionRequestRoutes } = await import('@server/routes/permissionRequest');
const app = createRouteTestApp('/permission-requests', permissionRequestRoutes);

describe('权限申请路由契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService.prototype, 'log').mockResolvedValue(undefined);
  });

  it('创建申请传入权限、范围、理由和当日结束有效期', async () => {
    const create = vi.spyOn(PermissionGovernanceService.prototype, 'createAndSubmit')
      .mockResolvedValue({ id: 12 } as any);
    const response = await request(app).post('/permission-requests').send({
      permissionCode: 'report:view:project',
      scopeType: 'project',
      scopeId: 8,
      reason: '负责项目周报',
      expiresAt: '2026-12-31',
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(3, expect.objectContaining({
      permissionCode: 'report:view:project', scopeType: 'project', scopeId: 8,
      reason: '负责项目周报', expiresAt: expect.any(Date),
    }));
    const expiresAt = create.mock.calls[0][1].expiresAt!;
    expect(expiresAt.getHours()).toBe(23);
    expect(expiresAt.getMinutes()).toBe(59);
  });

  it('拒绝非法范围类型和过长申请理由', async () => {
    const create = vi.spyOn(PermissionGovernanceService.prototype, 'createAndSubmit');
    const invalidScope = await request(app).post('/permission-requests').send({
      permissionCode: 'report:view:project', scopeType: 'team', reason: '业务需要',
    });
    expect(invalidScope.status).toBe(400);

    const longReason = await request(app).post('/permission-requests').send({
      permissionCode: 'report:view:project', scopeType: 'project', scopeId: 8, reason: 'a'.repeat(1001),
    });
    expect(longReason.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('撤销授权必须提供原因，并记录当前操作人', async () => {
    const revoke = vi.spyOn(PermissionGovernanceService.prototype, 'revokeGrant').mockResolvedValue({ id: 5 } as any);
    const missingReason = await request(app).post('/permission-requests/grants/5/revoke').send({ reason: '   ' });
    expect(missingReason.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();

    const valid = await request(app).post('/permission-requests/grants/5/revoke').send({ reason: '岗位调整' });
    expect(valid.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(5, 3, '岗位调整');
  });

  it('我的申请始终锁定当前用户，不接受查询参数越权', async () => {
    const getRequests = vi.spyOn(PermissionGovernanceService.prototype, 'getRequests').mockResolvedValue({
      list: [], total: 0, page: 1, pageSize: 20,
    });
    const response = await request(app).get('/permission-requests/my?applicantId=999&status=submitted');
    expect(response.status).toBe(200);
    expect(getRequests).toHaveBeenCalledWith(expect.objectContaining({ applicantId: 3, status: 'submitted' }));
  });

  it('返回可申请权限目录和授权用户选项', async () => {
    const definitions = vi.spyOn(PermissionGovernanceService.prototype, 'getGrantableDefinitions')
      .mockResolvedValue([{ code: 'report:view:project' }] as any);
    const users = vi.spyOn(PermissionGovernanceService.prototype, 'getUserOptions')
      .mockResolvedValue([{ id: 2, realName: '用户' }] as any);
    expect((await request(app).get('/permission-requests/grantable-permissions')).status).toBe(200);
    expect(definitions).toHaveBeenCalledOnce();
    expect((await request(app).get('/permission-requests/users')).status).toBe(200);
    expect(users).toHaveBeenCalledOnce();
  });

  it('管理员申请与授权列表使用白名单筛选和分页', async () => {
    const requests = vi.spyOn(PermissionGovernanceService.prototype, 'getRequests').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 10,
    });
    const grants = vi.spyOn(PermissionGovernanceService.prototype, 'getGrants').mockResolvedValue({
      list: [], total: 0, page: 3, pageSize: 5,
    });
    expect((await request(app).get('/permission-requests/all?status=approved&page=2&pageSize=10')).status).toBe(200);
    expect(requests).toHaveBeenCalledWith({ status: 'approved', page: 2, pageSize: 10 });
    expect((await request(app).get('/permission-requests/grants?userId=9&status=active&page=3&pageSize=5')).status).toBe(200);
    expect(grants).toHaveBeenCalledWith({ userId: 9, status: 'active', page: 3, pageSize: 5 });
  });

  it('申请人只能撤回自己的申请', async () => {
    const withdraw = vi.spyOn(PermissionGovernanceService.prototype, 'withdraw').mockResolvedValue({ id: 6 } as any);
    const response = await request(app).post('/permission-requests/6/withdraw');
    expect(response.status).toBe(200);
    expect(withdraw).toHaveBeenCalledWith(6, 3);
  });
});
