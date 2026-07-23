import { afterEach, describe, expect, it, vi } from 'vitest';
import { DingTalkAdapter } from '@server/services/oidc/dingtalkAdapter';
import type { OidcProviderConfig } from '@server/config/auth';

function config(secret = 'secret'): OidcProviderConfig {
  return {
    enabled: true,
    label: '钉钉',
    type: 'dingtalk',
    dingtalk: { clientId: 'ding-app', clientSecret: secret },
  };
}

function response(status: number, body: any, textError = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => {
      if (textError) throw new Error('读取失败');
      return JSON.stringify(body);
    }),
  } as any;
}

afterEach(() => vi.unstubAllGlobals());

describe('DingTalkAdapter', () => {
  it('生成带完整防重放 state 的授权地址', async () => {
    const adapter = new DingTalkAdapter('dingtalk', config());
    await expect(adapter.prepareAuth()).resolves.toEqual({});
    const url = new URL(await adapter.getAuthorizationUrl({
      redirectUri: 'https://worktime.example/oidc/callback',
      state: 'signed-state',
    }));
    expect(url.origin + url.pathname).toBe('https://login.dingtalk.com/oauth2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'ding-app',
      redirect_uri: 'https://worktime.example/oidc/callback',
      response_type: 'code',
      state: 'signed-state',
    });
  });

  it('换取令牌后使用 unionId 作为稳定身份', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { accessToken: 'access-token' }))
      .mockResolvedValueOnce(response(200, { unionId: 'union-1', openId: 'open-1', nick: '张三', email: 'z@oppo.com' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new DingTalkAdapter('dingtalk', config()).getUserInfo({
      code: 'code', state: 'state', redirectUri: 'https://callback',
    });

    expect(result).toEqual({
      subject: 'union-1',
      username: '张三',
      email: 'z@oppo.com',
      groups: undefined,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('state');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'x-acs-dingtalk-access-token': 'access-token' });
  });

  it('缺少配置、令牌或身份标识时返回明确业务错误', async () => {
    const missing = new DingTalkAdapter('dingtalk', { ...config(), dingtalk: undefined });
    await expect(missing.getAuthorizationUrl({ redirectUri: 'x', state: 's' })).rejects.toThrow('缺少 clientId/clientSecret');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {})));
    await expect(new DingTalkAdapter('dingtalk', config()).getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
      .rejects.toThrow('未返回 accessToken');

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { accessToken: 'token' }))
      .mockResolvedValueOnce(response(200, { nick: '无标识用户' })));
    await expect(new DingTalkAdapter('dingtalk', config()).getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
      .rejects.toThrow('未返回 unionId/openId');
  });

  it('外部接口非成功响应时不泄露响应正文', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401, { secret: 'remote detail' }, true)));
    await expect(new DingTalkAdapter('dingtalk', config()).getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('换取 accessToken 失败（401）') });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { accessToken: 'token' }))
      .mockResolvedValueOnce(response(503, { error: 'down' })));
    await expect(new DingTalkAdapter('dingtalk', config()).getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
      .rejects.toThrow('获取用户信息失败（503）');
  });

  it('网络异常和无效 JSON 都映射为 502 身份源错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));
    await expect(new DingTalkAdapter('dingtalk', config()).getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('请求异常') });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('invalid json')),
    }));
    await expect(new DingTalkAdapter('dingtalk', config()).getUserInfo({ code: 'c', state: 's', redirectUri: 'r' }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('无效数据') });
  });
});
