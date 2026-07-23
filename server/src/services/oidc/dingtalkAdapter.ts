import { OidcProvider, ProviderUserInfo, AuthPreparation } from './provider';
import { OidcProviderConfig } from '../../config/auth';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../utils/logger';

// 复用项目已有的 HTTP 能力。server 未引入 axios，使用 Node 内置 fetch（Node 18+ 原生支持）。

/**
 * 钉钉适配器（非标准 OAuth2，与标准 OIDC 协议不同）。
 *
 * 流程：
 * 1. 引导用户到 https://login.dingtalk.com/oauth2/auth 授权
 * 2. 回调拿到 authCode，POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken 换 accessToken
 * 3. GET https://api.dingtalk.com/v1.0/contact/users/me 取用户信息（unionId/openId/nick/email）
 *
 * 身份标识用 unionId（同一员工在同一开发者账号下跨应用稳定）。
 *
 * 参考文档：
 * - https://open.dingtalk.com/document/development/obtain-identity-credentials
 * - https://open.dingtalk.com/document/development/obtain-user-token
 * - https://open.dingtalk.com/document/orgapp-server/dingtalk-retrieve-user-information
 */
export class DingTalkAdapter implements OidcProvider {
  name: string;
  config: OidcProviderConfig;

  constructor(name: string, config: OidcProviderConfig) {
    this.name = name;
    this.config = config;
  }

  private requireConfig(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = this.config.dingtalk ?? {};
    if (!clientId || !clientSecret) {
      throw new BusinessError(`钉钉提供商【${this.config.label}】缺少 clientId/clientSecret 配置`, 500);
    }
    return { clientId, clientSecret };
  }

  private async request(url: string, init: RequestInit, operation: string): Promise<Response> {
    const configuredTimeout = Number(process.env.OIDC_REQUEST_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 1000
      ? Math.min(configuredTimeout, 60_000)
      : 10_000;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      logger.error({ err: error, provider: this.name, operation }, '钉钉登录请求异常');
      throw new BusinessError(`钉钉登录失败：${operation}请求异常，请稍后重试`, 502);
    }
  }

  private async responseJson(res: Response, operation: string): Promise<any> {
    try {
      return await res.json();
    } catch (error) {
      logger.error({ err: error, status: res.status, provider: this.name, operation }, '钉钉响应解析失败');
      throw new BusinessError(`钉钉登录失败：${operation}返回了无效数据`, 502);
    }
  }

  /** 钉钉无 nonce 概念，返回空；state 由本系统 HMAC 层提供防 CSRF */
  async prepareAuth(): Promise<AuthPreparation> {
    return {};
  }

  async getAuthorizationUrl(params: { redirectUri: string; state: string; nonce?: string }): Promise<string> {
    const { clientId } = this.requireConfig();
    const url = new URL('https://login.dingtalk.com/oauth2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  async getUserInfo(params: {
    code: string;
    state: string;
    redirectUri: string;
    nonce?: string;
  }): Promise<ProviderUserInfo> {
    const { clientId, clientSecret } = this.requireConfig();

    // 1. authCode 换 userAccessToken
    const tokenRes = await this.request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        code: params.code,
        grantType: 'authorization_code',
      }),
    }, '换取 accessToken');
    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status, provider: this.name }, '钉钉 userAccessToken 请求失败');
      throw new BusinessError(`钉钉登录失败：换取 accessToken 失败（${tokenRes.status}）`, 502);
    }
    const tokenBody = await this.responseJson(tokenRes, '换取 accessToken');
    const accessToken = tokenBody?.accessToken;
    if (!accessToken) {
      throw new BusinessError('钉钉登录失败：未返回 accessToken（授权码可能已过期）', 502);
    }

    // 2. accessToken 取用户信息
    const userRes = await this.request('https://api.dingtalk.com/v1.0/contact/users/me', {
      headers: { 'x-acs-dingtalk-access-token': accessToken },
    }, '获取用户信息');
    if (!userRes.ok) {
      logger.error({ status: userRes.status, provider: this.name }, '钉钉用户信息请求失败');
      throw new BusinessError(`钉钉登录失败：获取用户信息失败（${userRes.status}）`, 502);
    }
    const userBody = await this.responseJson(userRes, '获取用户信息');
    // unionId 跨应用稳定，作为身份唯一标识；openId 次之
    const subject = userBody?.unionId || userBody?.openId;
    if (!subject) {
      throw new BusinessError('钉钉登录失败：未返回 unionId/openId', 502);
    }

    return {
      subject,
      username: userBody?.nick || userBody?.email,
      email: userBody?.email,
      // 钉钉无 groups 概念，角色由本地管理员维护
      groups: undefined,
    };
  }
}
