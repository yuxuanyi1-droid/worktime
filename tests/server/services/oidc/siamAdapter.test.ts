import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SiamAdapter } from '@server/services/oidc/siamAdapter';
import type { OidcProviderConfig } from '@server/config/auth';

/**
 * SiamAdapter 单元测试：mock 全局 fetch，覆盖
 * 授权 URL 拼接、code→token 换取（成功/失败）、profile 取用户（三种属性嵌套位置）、配置缺失。
 */

function mkConfig(overrides: Partial<OidcProviderConfig> = {}): OidcProviderConfig {
  return {
    enabled: true,
    label: 'OPPO SIAM',
    type: 'siam',
    jit: false,
    clientId: 'ai_test_rca',
    clientSecret: 'secret_xxx',
    ssoBaseUrl: 'https://sso.myoas.com',
    ...overrides,
  };
}

/** 构造一个能按 URL 路径分流的 mock fetch */
function mockFetch(routes: Record<string, (url: URL) => { status: number; json?: any; ok?: boolean }>) {
  const fetchMock = vi.fn(async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    // 按路径后缀匹配路由
    const handler = Object.entries(routes).find(([path]) => url.pathname.endsWith(path))?.[1];
    if (!handler) throw new Error(`mock fetch: 未匹配到路由 ${url.pathname}`);
    const res = handler(url);
    return {
      ok: res.ok ?? (res.status >= 200 && res.status < 300),
      status: res.status,
      json: async () => res.json ?? {},
      text: async () => (typeof res.json === 'object' ? JSON.stringify(res.json) : String(res.json ?? '')),
    } as any;
  });
  return fetchMock;
}

describe('SiamAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('getAuthorizationUrl', () => {
    it('拼接 SIAM 授权 URL（含 client_id/redirect_uri/response_type/state）', async () => {
      const adapter = new SiamAdapter('siam', mkConfig());
      const url = await adapter.getAuthorizationUrl({
        redirectUri: 'https://app.example.com/oidc/callback',
        state: 'STATE_TOKEN',
      });
      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://sso.myoas.com');
      expect(parsed.pathname).toBe('/siam/oauth2.0/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('ai_test_rca');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/oidc/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('state')).toBe('STATE_TOKEN');
    });

    it('缺 clientId 抛 500 配置错误', async () => {
      const adapter = new SiamAdapter('siam', mkConfig({ clientId: undefined as any }));
      await expect(adapter.getAuthorizationUrl({ redirectUri: 'x', state: 's' }))
        .rejects.toThrow(/缺少 clientId\/clientSecret 配置/);
    });

    it('ssoBaseUrl 末尾斜杠被规范化', async () => {
      const adapter = new SiamAdapter('siam', mkConfig({ ssoBaseUrl: 'https://sso.myoas.com///' }));
      const url = await adapter.getAuthorizationUrl({ redirectUri: 'x', state: 's' });
      expect(new URL(url).origin).toBe('https://sso.myoas.com');
    });

    it('未配 ssoBaseUrl 时回退默认 sso.myoas.com', async () => {
      const adapter = new SiamAdapter('siam', mkConfig({ ssoBaseUrl: undefined }));
      const url = await adapter.getAuthorizationUrl({ redirectUri: 'x', state: 's' });
      expect(new URL(url).origin).toBe('https://sso.myoas.com');
    });
  });

  describe('prepareAuth', () => {
    it('返回空对象（SIAM 无 nonce）', async () => {
      const adapter = new SiamAdapter('siam', mkConfig());
      const prep = await adapter.prepareAuth();
      expect(prep).toEqual({});
    });
  });

  describe('getUserInfo', () => {
    const tokenRoute = (_url: URL) => ({
      status: 200,
      json: { status: true, access_token: 'TOKEN_abc' },
    });

    it('attributes 嵌套位置：标准映射 id→subject / uid→工号 / userCn→姓名 / mail / mobile / orgPath', async () => {
      const profileRoute = (_url: URL) => ({
        status: 200,
        json: {
          status: true,
          id: 'u-1001',
          attributes: {
            uid: '1001',
            userCn: '张三',
            mail: 'zhangsan@oppo.com',
            mobile: '13800000000',
            orgPath: '/OPPO/研发部/前端组',
          },
        },
      });
      globalThis.fetch = mockFetch({
        '/accessTokenByJson': tokenRoute,
        '/profileByJson': profileRoute,
      }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      const info = await adapter.getUserInfo({
        code: 'CODE_x',
        state: 's',
        redirectUri: 'https://app.example.com/oidc/callback',
      });
      expect(info.subject).toBe('u-1001');
      expect(info.username).toBe('1001');
      expect(info.displayName).toBe('张三');
      expect(info.email).toBe('zhangsan@oppo.com');
      expect(info.phone).toBe('13800000000');
      expect(info.employeeId).toBe('1001');
      expect(info.department).toBe('/OPPO/研发部/前端组');
      expect(info.groups).toBeUndefined();
    });

    it('userAttributes 嵌套位置（不同 SIAM 版本兼容）', async () => {
      const profileRoute = (_url: URL) => ({
        status: 200,
        json: {
          status: true,
          id: 'u-2002',
          userAttributes: { uid: '2002', userCn: '李四', mail: 'li@oppo.com' },
        },
      });
      globalThis.fetch = mockFetch({
        '/accessTokenByJson': tokenRoute,
        '/profileByJson': profileRoute,
      }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      const info = await adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' });
      expect(info.subject).toBe('u-2002');
      expect(info.username).toBe('2002');
      expect(info.displayName).toBe('李四');
      expect(info.email).toBe('li@oppo.com');
    });

    it('字段在顶层（无 attributes 嵌套）也能兜底解析', async () => {
      const profileRoute = (_url: URL) => ({
        status: 200,
        json: {
          status: true,
          id: 'u-3003',
          uid: '3003',
          userCn: '王五',
          mail: 'wang@oppo.com',
        },
      });
      globalThis.fetch = mockFetch({
        '/accessTokenByJson': tokenRoute,
        '/profileByJson': profileRoute,
      }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      const info = await adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' });
      expect(info.subject).toBe('u-3003');
      expect(info.username).toBe('3003');
      expect(info.displayName).toBe('王五');
      expect(info.email).toBe('wang@oppo.com');
    });

    it('id 为数字时转为字符串 subject', async () => {
      const profileRoute = (_url: URL) => ({
        status: 200,
        json: { status: true, id: 99999, attributes: { uid: 99999, userCn: '赵六' } },
      });
      globalThis.fetch = mockFetch({
        '/accessTokenByJson': tokenRoute,
        '/profileByJson': profileRoute,
      }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      const info = await adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' });
      expect(info.subject).toBe('99999');
      expect(info.employeeId).toBe('99999');
    });

    it('换 token 时 status:false 抛 502 业务错误', async () => {
      const failToken = (_url: URL) => ({
        status: 200,
        json: { status: false, error: 'invalid_grant', errorMsg: '授权码已过期' },
      });
      globalThis.fetch = mockFetch({ '/accessTokenByJson': failToken }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
        .rejects.toThrow(/换取 access_token 失败/);
    });

    it('换 token 时 HTTP 非 2xx 抛 502 业务错误', async () => {
      const failToken = (_url: URL) => ({ status: 500, json: { error: 'server' } });
      globalThis.fetch = mockFetch({ '/accessTokenByJson': failToken }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
        .rejects.toThrow(/HTTP 500/);
    });

    it('网络异常和无效 JSON 都映射为可理解的 502 身份源错误', async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('socket reset')) as any;
      const adapter = new SiamAdapter('siam', mkConfig());
      await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
        .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('请求异常') });

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('invalid json')),
      }) as any;
      await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
        .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('无效数据') });
    });

    it('profile 接口缺 id 抛 502', async () => {
      const profileRoute = (_url: URL) => ({
        status: 200,
        json: { status: true, attributes: { userCn: '无id' } },
      });
      globalThis.fetch = mockFetch({
        '/accessTokenByJson': tokenRoute,
        '/profileByJson': profileRoute,
      }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      await expect(adapter.getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
        .rejects.toThrow(/未返回用户唯一标识/);
    });

    it('换 token 请求 URL 含 code/client_id/client_secret/redirect_uri/grant_type', async () => {
      let captured: URL | null = null;
      const captureToken = (url: URL) => {
        captured = url;
        return { status: 200, json: { status: true, access_token: 'T' } };
      };
      const profileRoute = (_url: URL) => ({
        status: 200,
        json: { status: true, id: 'u-1', attributes: {} },
      });
      globalThis.fetch = mockFetch({
        '/accessTokenByJson': captureToken,
        '/profileByJson': profileRoute,
      }) as any;

      const adapter = new SiamAdapter('siam', mkConfig());
      await adapter.getUserInfo({ code: 'CODE_Y', state: 's', redirectUri: 'https://app/oidc/callback' });
      expect(captured).not.toBeNull();
      expect(captured!.searchParams.get('grant_type')).toBe('authorization_code');
      expect(captured!.searchParams.get('code')).toBe('CODE_Y');
      expect(captured!.searchParams.get('client_id')).toBe('ai_test_rca');
      expect(captured!.searchParams.get('client_secret')).toBe('secret_xxx');
      expect(captured!.searchParams.get('redirect_uri')).toBe('https://app/oidc/callback');
    });
  });
});
