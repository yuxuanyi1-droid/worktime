import { OidcProvider, ProviderUserInfo, AuthPreparation } from './provider';
import { OidcProviderConfig } from '../../config/auth';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * OPPO SIAM OAuth2 直连模式适配器（非标准 OAuth2）。
 *
 * SIAM 与标准 OIDC 的关键差异：
 * - 全部接口走 GET + Query，连 token 交换都用 GET（client_secret 通过 query 传，仅后端调用）
 * - 不支持 OIDC discovery / JWKS / id_token，无 nonce 概念（纯 OAuth2）
 * - accessTokenByJson 响应为私有格式 { status: true, access_token }（standard 模式下含 expires_in）
 * - profileByJson 用户属性嵌套在 attributes 中（不同 SIAM 版本可能为 userAttributes 或顶层）
 *
 * 流程：
 * 1. 引导浏览器到 {ssoBaseUrl}/siam/oauth2.0/authorize 授权
 * 2. 回调拿到 code，GET {ssoBaseUrl}/siam/oauth2.0/accessTokenByJson 换 access_token
 * 3. GET {ssoBaseUrl}/siam/oauth2.0/profileByJson 取用户信息（id/attributes）
 *
 * 身份标识用 SIAM 返回的顶层 id（用户唯一标识），作为 (provider, subject) 绑定键。
 *
 * 关于 access_token 有效期（约 12 小时）：本实现采用授权码流程 + 即用即弃，
 * 不持久化/缓存 access_token。OAuth code 是一次性的，每次登录必须用新 code 重新换 token，
 * 故 token 有效期不影响实现——会话期免再调 SIAM 由本地 JWT（默认 24h）承担。
 *
 * 参考文档：OPPO SIAM OAuth2 直连模式接口调用参考。
 */
export class SiamAdapter implements OidcProvider {
  name: string;
  config: OidcProviderConfig;

  constructor(name: string, config: OidcProviderConfig) {
    this.name = name;
    this.config = config;
  }

  /** SIAM 直连模式默认基址 */
  private get ssoBaseUrl(): string {
    const base = (this.config.ssoBaseUrl || 'https://sso.myoas.com').replace(/\/+$/, '');
    return base;
  }

  private requireConfig(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret) {
      throw new BusinessError(`OPPO SIAM 提供商【${this.config.label}】缺少 clientId/clientSecret 配置`, 500);
    }
    return { clientId, clientSecret };
  }

  private async request(url: URL, operation: string): Promise<Response> {
    const configuredTimeout = Number(process.env.OIDC_REQUEST_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 1000
      ? Math.min(configuredTimeout, 60_000)
      : 10_000;
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      logger.error({ err: error, provider: this.name, operation }, 'OPPO SIAM 请求异常');
      throw new BusinessError(`OPPO SIAM 登录失败：${operation}请求异常，请稍后重试`, 502);
    }
  }

  private async responseJson(res: Response, operation: string): Promise<any> {
    try {
      return await res.json();
    } catch (error) {
      logger.error({ err: error, status: res.status, provider: this.name, operation }, 'OPPO SIAM 响应解析失败');
      throw new BusinessError(`OPPO SIAM 登录失败：${operation}返回了无效数据`, 502);
    }
  }

  /** SIAM 无 nonce 概念，返回空；state 由本系统 HMAC 层提供防 CSRF */
  async prepareAuth(): Promise<AuthPreparation> {
    return {};
  }

  async getAuthorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce?: string;
  }): Promise<string> {
    const { clientId } = this.requireConfig();
    const url = new URL(`${this.ssoBaseUrl}/siam/oauth2.0/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
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

    // 1. code 换 access_token（GET + Query，client_secret 通过 query 传，仅后端调用）
    const tokenUrl = new URL(`${this.ssoBaseUrl}/siam/oauth2.0/accessTokenByJson`);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    tokenUrl.searchParams.set('code', params.code);
    tokenUrl.searchParams.set('client_id', clientId);
    tokenUrl.searchParams.set('client_secret', clientSecret);
    tokenUrl.searchParams.set('redirect_uri', params.redirectUri);

    const tokenRes = await this.request(tokenUrl, '换取 access_token');
    if (!tokenRes.ok) {
      // 不记录响应正文或请求 URL，避免身份源错误页回显 client_secret/code 后进入日志。
      logger.error({ status: tokenRes.status, provider: this.name }, 'OPPO SIAM accessToken 请求失败');
      throw new BusinessError(`OPPO SIAM 登录失败：换取 access_token 失败（HTTP ${tokenRes.status}）`, 502);
    }
    const tokenBody = await this.responseJson(tokenRes, '换取 access_token');
    // SIAM 私有格式 { status: true, access_token }；standard 模式下为标准 { access_token, expires_in }
    if (tokenBody?.status === false || !tokenBody?.access_token) {
      const err = tokenBody?.error || tokenBody?.errorMsg || '未返回 access_token';
      throw new BusinessError(`OPPO SIAM 登录失败：换取 access_token 失败（${err}）`, 502);
    }
    const accessToken = tokenBody.access_token as string;

    // 2. access_token 取用户信息（GET + Query）
    const profileUrl = new URL(`${this.ssoBaseUrl}/siam/oauth2.0/profileByJson`);
    profileUrl.searchParams.set('access_token', accessToken);

    const profileRes = await this.request(profileUrl, '获取用户信息');
    if (!profileRes.ok) {
      logger.error({ status: profileRes.status, provider: this.name }, 'OPPO SIAM profile 请求失败');
      throw new BusinessError(`OPPO SIAM 登录失败：获取用户信息失败（HTTP ${profileRes.status}）`, 502);
    }
    const profileBody = await this.responseJson(profileRes, '获取用户信息');
    // SIAM 私有格式同样可能包 { status: true, attributes: {...}, id: '...' }
    if (profileBody?.status === false) {
      const err = profileBody?.error || profileBody?.errorMsg || '未知错误';
      throw new BusinessError(`OPPO SIAM 登录失败：获取用户信息失败（${err}）`, 502);
    }

    // 3. 用户唯一标识：顶层 id（文档定义为用户唯一标识）
    const subject = profileBody?.id;
    if (!subject) {
      throw new BusinessError('OPPO SIAM 登录失败：未返回用户唯一标识（id）', 502);
    }

    // 4. 属性兼容三处位置：attributes / userAttributes / 顶层（不同 SIAM 版本差异，按文档建议都检查）
    const attrs = { ...(profileBody?.attributes || {}), ...(profileBody?.userAttributes || {}), ...profileBody };

    return {
      subject: String(subject),
      username: pickStr(attrs, 'uid', 'userAccount', 'loginName'),
      displayName: pickStr(attrs, 'userCn', 'cn', 'displayName', 'name'),
      email: pickStr(attrs, 'mail', 'email'),
      phone: pickStr(attrs, 'mobile', 'phone', 'phoneNumber'),
      // 部门路径（jit=false 下不参与 JIT 建号，仅占位；字段保留以备未来启用 jit）
      department: pickStr(attrs, 'orgPath', 'department', 'orgFullName'),
      // 工号
      employeeId: pickStr(attrs, 'uid', 'employeeId', 'employeeNumber'),
      // SIAM 无 OIDC groups claim 概念，角色由本地管理员维护
      groups: undefined,
    };
  }
}

/**
 * 从 attrs 中按优先级取首个非空字符串值（trim 后非空）。
 * 兼容 SIAM 不同版本字段命名差异。
 */
function pickStr(attrs: Record<string, any>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = attrs?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}
