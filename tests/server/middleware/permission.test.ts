import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthRequest } from '@server/middleware/auth';
import { isAdmin, requireAllPermissions, requirePermission, requireRole } from '@server/middleware/permission';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function request(roles: string[] = ['employee'], permissions: string[] = []): AuthRequest {
  return {
    user: { id: 1, username: 'tester', realName: '测试用户', roles },
    userPermissions: new Set(permissions),
  } as AuthRequest;
}

describe('权限中间件', () => {
  it('未登录返回 401', async () => {
    const req = {} as AuthRequest;
    const res = response();
    const next = vi.fn();
    await requirePermission('timesheet:view:self')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('任一权限与全部权限语义严格区分', async () => {
    const req = request(['employee'], ['a']);
    const anyNext = vi.fn();
    const allNext = vi.fn();
    const denied = response();

    await requirePermission('a', 'b')(req, response(), anyNext);
    await requireAllPermissions('a', 'b')(req, denied, allNext);

    expect(anyNext).toHaveBeenCalledOnce();
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(allNext).not.toHaveBeenCalled();
  });

  it('角色校验只接受指定角色，管理员始终放行', async () => {
    const denied = response();
    const deniedNext = vi.fn();
    await requireRole('manager')(request(['employee']), denied, deniedNext);
    expect(denied.status).toHaveBeenCalledWith(403);

    const adminReq = request(['admin']);
    const adminNext = vi.fn();
    await requireAllPermissions('never:assigned')(adminReq, response(), adminNext);
    expect(isAdmin(adminReq)).toBe(true);
    expect(adminNext).toHaveBeenCalledOnce();
  });
});
