import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OidcProviderConfig } from '@server/config/auth';

const oidc = vi.hoisted(() => ({
  discovery: vi.fn(),
  clientSecretPost: vi.fn((secret?: string) => ({ secret })),
  buildAuthorizationUrl: vi.fn((_config: any, params: any) => {
    const url = new URL('https://idp.example/authorize');
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url;
  }),
  authorizationCodeGrant: vi.fn(),
  fetchUserInfo: vi.fn(),
  randomNonce: vi.fn(() => 'secure-nonce'),
  skipStateCheck: Symbol('skip-state'),
}));

vi.mock('openid-client', () => ({
  discovery: oidc.discovery,
  ClientSecretPost: oidc.clientSecretPost,
  buildAuthorizationUrl: oidc.buildAuthorizationUrl,
  authorizationCodeGrant: oidc.authorizationCodeGrant,
  fetchUserInfo: oidc.fetchUserInfo,
  randomPKCECodeVerifier: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  randomNonce: oidc.randomNonce,
  skipStateCheck: oidc.skipStateCheck,
}));

const { OidcAdapter } = await import('@server/services/oidc/oidcAdapter');

function config(overrides: Partial<OidcProviderConfig> = {}): OidcProviderConfig {
  return {
    enabled: true,
    label: '公司统一登录',
    type: 'oidc',
    issuer: 'https://idp.example',
    clientId: 'worktime',
    clientSecret: 'secret',
    scopes: ['openid', 'profile'],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('OidcAdapter', () => {
  it('校验必要配置并生成 nonce', async () => {
    await expect(new OidcAdapter('corp', config({ issuer: undefined })).getAuthorizationUrl({
      redirectUri: 'https://app/callback', state: 's', nonce: 'n',
    })).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('缺少 issuer/clientId/clientSecret') });

    await expect(new OidcAdapter('corp', config()).prepareAuth()).resolves.toEqual({ nonce: 'secure-nonce' });
  });

  it('缓存 discovery 结果并构造完整授权 URL', async () => {
    const serverConfig = { issuer: 'discovered' };
    oidc.discovery.mockResolvedValue(serverConfig);
    const adapter = new OidcAdapter('corp', config());

    const params = { redirectUri: 'https://app.example/callback', state: 'signed-state', nonce: 'nonce' };
    const first = new URL(await adapter.getAuthorizationUrl(params));
    await adapter.getAuthorizationUrl(params);

    expect(oidc.discovery).toHaveBeenCalledOnce();
    expect(oidc.discovery).toHaveBeenCalledWith(
      new URL('https://idp.example'),
      'worktime',
      {},
      { secret: 'secret' },
    );
    expect(first.searchParams.get('scope')).toBe('openid profile');
    expect(first.searchParams.get('state')).toBe('signed-state');
    expect(first.searchParams.get('nonce')).toBe('nonce');
  });

  it('discovery 失败后清理缓存，允许下一次重试恢复', async () => {
    oidc.discovery.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true });
    const adapter = new OidcAdapter('corp', config());
    const params = { redirectUri: 'https://app/callback', state: 's', nonce: 'n' };

    await expect(adapter.getAuthorizationUrl(params)).rejects.toMatchObject({ statusCode: 502 });
    await expect(adapter.getAuthorizationUrl(params)).resolves.toContain('https://idp.example/authorize');
    expect(oidc.discovery).toHaveBeenCalledTimes(2);
  });

  it('校验授权码结果并合并 userinfo 扩展字段', async () => {
    oidc.discovery.mockResolvedValue({ discovered: true });
    const claims = vi.fn(() => ({ sub: 'subject-1', preferred_username: 'zhangsan', name: '张三' }));
    oidc.authorizationCodeGrant.mockResolvedValue({ claims, access_token: 'access' });
    oidc.fetchUserInfo.mockResolvedValue({
      email: 'z@oppo.com', phone_number: '13800000000', department: '研发部',
      employee_id: '10001', groups: ['dev'],
    });
    const adapter = new OidcAdapter('corp', config());

    const result = await adapter.getUserInfo({
      code: 'auth-code',
      state: 'signed-state',
      nonce: 'nonce',
      redirectUri: 'https://app.example/callback',
    });

    const callbackUrl = oidc.authorizationCodeGrant.mock.calls[0][1] as URL;
    expect(callbackUrl.searchParams.get('code')).toBe('auth-code');
    expect(callbackUrl.searchParams.get('state')).toBe('signed-state');
    expect(oidc.authorizationCodeGrant.mock.calls[0][2]).toEqual({
      expectedState: oidc.skipStateCheck,
      expectedNonce: 'nonce',
    });
    expect(result).toEqual({
      subject: 'subject-1', username: 'zhangsan', displayName: '张三',
      email: 'z@oppo.com', phone: '13800000000', department: '研发部',
      employeeId: '10001', groups: ['dev'],
    });
  });

  it('userinfo 不可用时安全回退到已验证的 id_token claims', async () => {
    oidc.discovery.mockResolvedValue({});
    oidc.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: 'subject-2', nickname: '小李', email: 'id-token@example.com' }),
      access_token: 'access',
    });
    oidc.fetchUserInfo.mockRejectedValue(new Error('userinfo offline'));

    await expect(new OidcAdapter('corp', config()).getUserInfo({
      code: 'c', state: 's', nonce: 'n', redirectUri: 'https://app/callback',
    })).resolves.toMatchObject({ subject: 'subject-2', username: '小李', email: 'id-token@example.com' });
  });

  it('翻译常见换令牌错误，并拒绝缺少 subject 的身份', async () => {
    oidc.discovery.mockResolvedValue({});
    oidc.authorizationCodeGrant.mockRejectedValueOnce({ error: 'invalid_grant', status: 400 });
    const adapter = new OidcAdapter('corp', config());
    await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'https://app/callback' }))
      .rejects.toThrow('授权码无效或已过期');

    oidc.authorizationCodeGrant.mockResolvedValueOnce({ claims: () => ({}), access_token: 'access' });
    await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'https://app/callback' }))
      .rejects.toThrow('未返回 subject');
  });
});
