import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createRouteTestApp } from '../helpers/http';

const mocks = vi.hoisted(() => ({
  oidcLogin: vi.fn(),
  bind: vi.fn(),
  listBindings: vi.fn(),
  unbind: vi.fn(),
  auditLog: vi.fn(),
  listProviders: vi.fn(),
  assertVisible: vi.fn(),
  signState: vi.fn(),
  verifyState: vi.fn(),
  getProvider: vi.fn(),
  prepareAuth: vi.fn(),
  getAuthorizationUrl: vi.fn(),
  getUserInfo: vi.fn(),
}));

vi.mock('@server/services/authService', () => ({
  AuthService: class { oidcLogin = mocks.oidcLogin; },
}));
vi.mock('@server/services/externalIdentityService', () => ({
  ExternalIdentityService: class {
    bind = mocks.bind;
    listBindings = mocks.listBindings;
    unbind = mocks.unbind;
  },
}));
vi.mock('@server/services/auditService', () => ({
  AuditService: class { log = mocks.auditLog; },
}));
vi.mock('@server/middleware/security', () => ({
  oidcCallbackLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer valid') {
      return res.status(401).json({ code: 401, message: '未登录' });
    }
    req.user = { id: 7, username: 'tester', realName: '测试用户', roles: ['employee'] };
    next();
  },
}));
vi.mock('@server/services/oidc/registry', () => ({
  listVisibleProviders: mocks.listProviders,
  assertProviderVisible: mocks.assertVisible,
  signState: mocks.signState,
  verifyState: mocks.verifyState,
  getProvider: mocks.getProvider,
}));

const { oidcRoutes } = await import('@server/routes/oidc');
const app = createRouteTestApp('/oidc', oidcRoutes);

describe('OIDC 路由登录与绑定流程', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listProviders.mockReturnValue([{ name: 'siam', label: 'SIAM' }]);
    mocks.signState.mockReturnValue('signed-state');
    mocks.verifyState.mockReturnValue({
      mode: 'login', provider: 'siam', redirect: '/', nonce: 'nonce-1',
    });
    mocks.prepareAuth.mockResolvedValue({ nonce: 'nonce-1' });
    mocks.getAuthorizationUrl.mockResolvedValue('https://idp.example/authorize');
    mocks.getUserInfo.mockResolvedValue({ subject: 'external-1', username: 'zhangsan' });
    mocks.getProvider.mockReturnValue({
      config: { label: 'SIAM' },
      prepareAuth: mocks.prepareAuth,
      getAuthorizationUrl: mocks.getAuthorizationUrl,
      getUserInfo: mocks.getUserInfo,
    });
    mocks.auditLog.mockResolvedValue(undefined);
  });

  it('未登录也能读取启用的登录提供商', async () => {
    const response = await request(app).get('/oidc/providers');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ name: 'siam', label: 'SIAM' }]);
  });

  it('登录发起把 provider、nonce 和安全跳转目标签入 state', async () => {
    const response = await request(app)
      .get('/oidc/siam/login?redirect=%2Freports&redirectUriBase=http%3A%2F%2Flocalhost%3A5173');

    expect(response.status).toBe(200);
    expect(response.body.data.url).toBe('https://idp.example/authorize');
    expect(mocks.signState).toHaveBeenCalledWith({
      mode: 'login', provider: 'siam', redirect: '/reports', nonce: 'nonce-1',
    });
    expect(mocks.getAuthorizationUrl).toHaveBeenCalledWith({
      redirectUri: 'http://localhost:5173/oidc/callback',
      state: 'signed-state',
      nonce: 'nonce-1',
    });
  });

  it('登录发起在服务端拒绝外部和编码后的协议相对跳转', async () => {
    const response = await request(app)
      .get('/oidc/siam/login?redirect=%2F%252f%252fevil.example&redirectUriBase=http%3A%2F%2Flocalhost%3A5173');

    expect(response.status).toBe(200);
    expect(mocks.signState).toHaveBeenCalledWith(expect.objectContaining({ redirect: '/' }));
  });

  it('绑定发起必须先认证，并把当前用户写入 state', async () => {
    const unauthenticated = await request(app).get('/oidc/siam/login?mode=bind');
    expect(unauthenticated.status).toBe(401);
    expect(mocks.prepareAuth).not.toHaveBeenCalled();

    const authenticated = await request(app)
      .get('/oidc/siam/login?mode=bind')
      .set('Authorization', 'Bearer valid');
    expect(authenticated.status).toBe(200);
    expect(mocks.signState).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'bind', provider: 'siam', userId: 7,
    }));
  });

  it('回调 provider 与签名 state 不一致时不向身份源交换授权码', async () => {
    mocks.verifyState.mockReturnValue({ mode: 'login', provider: 'other', nonce: 'nonce-1' });
    const response = await request(app)
      .post('/oidc/siam/callback')
      .send({ code: 'code-1', state: 'signed-state' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('state 中的 provider 与请求不匹配');
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
  });

  it('绑定回调在交换授权码前校验发起者与当前用户一致', async () => {
    mocks.verifyState.mockReturnValue({
      mode: 'bind', provider: 'siam', userId: 8, nonce: 'nonce-1',
    });
    const response = await request(app)
      .post('/oidc/siam/callback')
      .set('Authorization', 'Bearer valid')
      .send({ code: 'code-1', state: 'signed-state' });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('绑定发起者与当前登录用户不一致');
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('登录回调用身份信息签发本地会话并写审计日志', async () => {
    mocks.oidcLogin.mockResolvedValue({
      token: 'local-jwt', user: { id: 11, username: 'zhangsan', realName: '张三' },
    });
    const response = await request(app)
      .post('/oidc/siam/callback')
      .send({ code: 'code-1', state: 'signed-state' });

    expect(response.status).toBe(200);
    expect(response.body.data.token).toBe('local-jwt');
    expect(response.body.data.redirect).toBe('/');
    expect(mocks.getUserInfo).toHaveBeenCalledWith(expect.objectContaining({
      code: 'code-1', state: 'signed-state', nonce: 'nonce-1',
    }));
    expect(mocks.oidcLogin).toHaveBeenCalledWith('siam', {
      subject: 'external-1', username: 'zhangsan',
    });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: 11, action: 'oidc_login', detail: 'siam',
    }));
  });

  it('登录回调只返回签名 state 中经过服务端校验的站内跳转', async () => {
    mocks.verifyState.mockReturnValue({
      mode: 'login', provider: 'siam', redirect: '//evil.example', nonce: 'nonce-1',
    });
    mocks.oidcLogin.mockResolvedValue({ token: 'local-jwt', user: { id: 11 } });
    const response = await request(app)
      .post('/oidc/siam/callback')
      .send({ code: 'code-1', state: 'signed-state' });

    expect(response.status).toBe(200);
    expect(response.body.data.redirect).toBe('/');
  });

  it('绑定回调返回外部账号摘要，且不签发新的本地 token', async () => {
    mocks.verifyState.mockReturnValue({
      mode: 'bind', provider: 'siam', userId: 7, nonce: 'nonce-1',
    });
    mocks.bind.mockResolvedValue({ id: 20, externalUsername: 'zhangsan' });
    const response = await request(app)
      .post('/oidc/siam/callback')
      .set('Authorization', 'Bearer valid')
      .send({ code: 'code-1', state: 'signed-state' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      provider: 'siam', providerLabel: 'SIAM', externalUsername: 'zhangsan',
    });
    expect(mocks.bind).toHaveBeenCalledWith(7, 'siam', {
      subject: 'external-1', username: 'zhangsan',
    });
    expect(mocks.oidcLogin).not.toHaveBeenCalled();
  });

  it('绑定列表与解绑接口均要求登录，解绑只能作用于当前用户', async () => {
    expect((await request(app).get('/oidc/bindings')).status).toBe(401);
    mocks.listBindings.mockResolvedValue([{ provider: 'siam', externalUsername: 'zhangsan' }]);
    const list = await request(app).get('/oidc/bindings').set('Authorization', 'Bearer valid');
    expect(list.body.data).toHaveLength(1);
    expect(mocks.listBindings).toHaveBeenCalledWith(7);

    const removed = await request(app)
      .delete('/oidc/bindings/siam')
      .set('Authorization', 'Bearer valid');
    expect(removed.status).toBe(200);
    expect(mocks.unbind).toHaveBeenCalledWith(7, 'siam');
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, action: 'oidc_unbind', detail: 'siam',
    }));
  });
});
