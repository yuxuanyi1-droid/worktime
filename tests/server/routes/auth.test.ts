import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuthService } from '@server/services/authService';
import { AuditService } from '@server/services/auditService';
import { BusinessError } from '@server/utils/errors';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 7, username: 'auth-user', realName: '认证用户', roles: ['employee'] };
    req.authMethod = 'jwt';
    next();
  },
}));

const { authRoutes } = await import('@server/routes/auth');
const app = createRouteTestApp('/auth', authRoutes);

describe('认证路由安全契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService.prototype, 'log').mockResolvedValue(undefined);
  });

  it('登录保留密码原始空格，且不在响应中暴露额外字段', async () => {
    const login = vi.spyOn(AuthService.prototype, 'login').mockResolvedValue({
      token: 'jwt-token',
      user: { id: 7, username: 'auth-user', realName: '认证用户', roles: [], permissions: [] },
    } as any);
    const response = await request(app).post('/auth/login').send({
      username: ' auth-user ',
      password: ' password-with-spaces ',
    });

    expect(response.status).toBe(200);
    expect(login).toHaveBeenCalledWith('auth-user', ' password-with-spaces ');
    expect(response.body).toMatchObject({ code: 0, data: { token: 'jwt-token' } });
  });

  it('连续五次凭据失败后，同 IP 与用户组合会被暂时锁定', async () => {
    const login = vi.spyOn(AuthService.prototype, 'login')
      .mockRejectedValue(new BusinessError('用户名或密码错误'));
    const username = 'lockout-route-user';

    for (let index = 0; index < 5; index += 1) {
      const failed = await request(app).post('/auth/login').send({ username, password: 'wrong-password' });
      expect(failed.status).toBe(400);
    }
    const locked = await request(app).post('/auth/login').send({ username, password: 'wrong-password' });
    expect(locked.status).toBe(429);
    expect(locked.body.message).toContain('登录失败次数过多');
    expect(login).toHaveBeenCalledTimes(5);
  });

  it('修改密码在服务调用前执行长度校验', async () => {
    const changePassword = vi.spyOn(AuthService.prototype, 'changePassword');
    const response = await request(app).put('/auth/change-password').send({
      oldPassword: 'old-password', newPassword: 'short',
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('不能少于8个字符');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('个人信息只接受允许修改的字段并校验联系方式', async () => {
    const update = vi.spyOn(AuthService.prototype, 'updateProfile').mockResolvedValue({ id: 7 } as any);
    const invalid = await request(app).put('/auth/profile').send({ phone: 'abc' });
    expect(invalid.status).toBe(400);
    expect(update).not.toHaveBeenCalled();

    const valid = await request(app).put('/auth/profile').send({
      username: 'cannot-change',
      realName: '新姓名',
      email: 'user@example.com',
      phone: '+86 138-0000-0000',
    });
    expect(valid.status).toBe(200);
    expect(update).toHaveBeenCalledWith(7, {
      realName: '新姓名', email: 'user@example.com', phone: '+86 138-0000-0000',
    });
  });

  it('个人资料读取与登出均锁定当前登录用户', async () => {
    const profile = vi.spyOn(AuthService.prototype, 'getProfile').mockResolvedValue({ id: 7 } as any);
    const logout = vi.spyOn(AuthService.prototype, 'logout').mockResolvedValue(undefined);
    expect((await request(app).get('/auth/profile')).status).toBe(200);
    expect(profile).toHaveBeenCalledWith(7);
    expect((await request(app).post('/auth/logout')).status).toBe(200);
    expect(logout).toHaveBeenCalledWith(7);
    expect(AuditService.prototype.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, action: 'logout',
    }));
  });

  it('修改密码保留原始空格并记录审计', async () => {
    const change = vi.spyOn(AuthService.prototype, 'changePassword').mockResolvedValue(undefined);
    const response = await request(app).put('/auth/change-password').send({
      oldPassword: ' old password ', newPassword: ' new password ',
    });
    expect(response.status).toBe(200);
    expect(change).toHaveBeenCalledWith(7, ' old password ', ' new password ');
    expect(AuditService.prototype.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'change_password', targetId: 7,
    }));
  });
});
