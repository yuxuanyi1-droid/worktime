import { OidcProvider, ProviderUserInfo, AuthPreparation } from './provider';
import { OidcProviderConfig } from '../../config/auth';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * openid-client v6 的运行时类型（动态 import 后获得）。
 * 因 v6 是纯 ESM 而 server tsconfig 为 commonjs，用动态 import() 加载。
 */
type OpenidClientModule = {
  // v6: discovery(server, clientId, metadata?, clientAuthentication?, options?)
  //   metadata 是 ClientMetadata（含 client_secret 等），clientAuthentication 是 ClientAuth
  discovery: (
    server: URL,
    clientId: string,
    metadata?: any,
    clientAuthentication?: any,
    options?: any
  ) => Promise<any>;
  // client 认证方式构造器：ClientSecretPost(secret) 把 secret 放进 POST body
  ClientSecretPost: (clientSecret?: string) => any;
  buildAuthorizationUrl: (config: any, params: any) => URL;
  // v6: authorizationCodeGrant(config, currentUrl, opts) —— currentUrl 必须带 code/state query；
  //     opts.expectedState 传 skipStateCheck symbol 可跳过 state 校验
  authorizationCodeGrant: (config: any, currentUrl: URL, opts: any) => Promise<any>;
  fetchUserInfo: (config: any, accessToken: string, expectedSubject?: string) => Promise<any>;
  randomPKCECodeVerifier: () => string;
  calculatePKCECodeChallenge: (verifier: string) => string;
  randomNonce: () => string;
  // v6 导出的 symbol，传给 expectedState/expectedNonce 以跳过该项校验
  skipStateCheck: symbol;
};

let openidClientPromise: Promise<OpenidClientModule> | null = null;
async function getOpenidClient(): Promise<OpenidClientModule> {
  if (!openidClientPromise) {
    // 动态 import 规避 openid-client v6 ESM-only 与 CJS 互操作问题
    // 用 unknown 中转，因为我们只用到模块的一个子集
    openidClientPromise = import('openid-client').then((m: unknown) => m as OpenidClientModule);
  }
  return openidClientPromise;
}

/**
 * 标准 OIDC 适配器（覆盖 Authentik、Keycloak、Okta 等所有标准 OIDC 提供商）。
 *
 * 基于 openid-client v6 的 discovery + PKCE 授权码流程：
 * - 首次使用时通过 OIDC discovery 端点自动获取 IdP 配置（含 JWKS）
 * - id_token 签名/aud/nonce 校验由 openid-client 自动完成
 */
export class OidcAdapter implements OidcProvider {
  name: string;
  config: OidcProviderConfig;
  /** discovery 结果缓存（避免每次请求都打 discovery 端点） */
  private serverConfigPromise: Promise<any> | null = null;

  constructor(name: string, config: OidcProviderConfig) {
    this.name = name;
    this.config = config;
  }

  private requireConfig(): { issuer: string; clientId: string; clientSecret: string } {
    const { issuer, clientId, clientSecret } = this.config;
    if (!issuer || !clientId || !clientSecret) {
      throw new BusinessError(`OIDC 提供商【${this.config.label}】缺少 issuer/clientId/clientSecret 配置`, 500);
    }
    return { issuer, clientId, clientSecret };
  }

  /** 懒加载 discovery（首次访问时初始化，后续缓存复用；失败则清空允许重试） */
  private async getServerConfig(): Promise<any> {
    if (this.serverConfigPromise) return this.serverConfigPromise;
    const { issuer, clientId, clientSecret } = this.requireConfig();
    // v6 discovery 签名：discovery(server, clientId, metadata?, clientAuthentication?)
    // clientSecret 必须通过 ClientSecretPost 显式传入认证方式，否则 token 端点拿不到 secret
    this.serverConfigPromise = getOpenidClient().then((oc) =>
      oc.discovery(
        new URL(issuer),
        clientId,
        {}, // metadata：无额外 client 元数据
        oc.ClientSecretPost(clientSecret) // client 认证方式：把 secret 放进 POST body
      )
    );
    try {
      return await this.serverConfigPromise;
    } catch (e) {
      this.serverConfigPromise = null;
      logger.error({ err: e, provider: this.name, issuer }, 'OIDC discovery 失败');
      throw new BusinessError(`无法连接 OIDC 提供商【${this.config.label}】，请检查 issuer 配置与网络`, 502);
    }
  }

  /** 生成 nonce（route 层会将其编入 HMAC state 供回调复用） */
  async prepareAuth(): Promise<AuthPreparation> {
    const oc = await getOpenidClient();
    return {
      nonce: oc.randomNonce(),
    };
  }

  /** 用最终 state + nonce 拼 IdP 授权 URL（不使用 PKCE，见下说明） */
  async getAuthorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce: string;
  }): Promise<string> {
    const oc = await getOpenidClient();
    const config = await this.getServerConfig();
    const scopes = this.config.scopes ?? ['openid', 'profile', 'email'];
    // 不使用 PKCE：本系统是后端 confidential client（持有 client_secret，认证由 secret 保证），
    // 且实测某些 IdP（如 Authentik 部分版本）在 PKCE 校验上存在缺陷会导致 invalid_grant。
    // confidential client 不依赖 PKCE 防 code 拦截，去掉 PKCE 兼容性更好。
    const url = oc.buildAuthorizationUrl(config, {
      redirect_uri: params.redirectUri,
      scope: scopes.join(' '),
      state: params.state,
      nonce: params.nonce,
    });
    return url.toString();
  }

  async getUserInfo(params: {
    code: string;
    state: string;
    redirectUri: string;
    nonce?: string;
  }): Promise<ProviderUserInfo> {
    const oc = await getOpenidClient();
    const config = await this.getServerConfig();
    // v6 的 authorizationCodeGrant 从 currentUrl 的 query 解析 code/state，
    // 因此要把前端回传的 code/state 拼到 callback URL 上再传入。
    const callbackUrl = new URL(params.redirectUri);
    callbackUrl.searchParams.set('code', params.code);
    callbackUrl.searchParams.set('state', params.state);

    // authorizationCodeGrant 会：用 code 换 token、校验 id_token 签名(JWKS)/aud/nonce/exp
    // state 已由 registry 在 HMAC 层校验，此处用 skipStateCheck symbol 跳过 openid-client 的 state 检查
    logger.debug({ provider: this.name, redirectUri: params.redirectUri }, 'OIDC 准备换 token');

    let tokenSet: any;
    try {
      tokenSet = await oc.authorizationCodeGrant(config, callbackUrl, {
        expectedState: oc.skipStateCheck,
        expectedNonce: params.nonce,
      });
    } catch (e: any) {
      // v6 / oauth4webapi 抛 ResponseBodyError 等专用错误，默认 message 不可读，
      // 这里提取 error/status/body 字段，给出真实原因（如 invalid_grant/redirect_uri_mismatch）。
      const errCode = e?.error || e?.code;
      const errStatus = e?.status;
      const errBody = typeof e?.body === 'string' ? e.body : JSON.stringify(e?.body);
      logger.error(
        { err: e, errorField: errCode, status: errStatus, body: errBody, provider: this.name },
        'OIDC 换 token 失败'
      );
      // 常见错误码翻译为中文提示
      const friendly: Record<string, string> = {
        invalid_grant: '授权码无效或已过期，请重新发起授权',
        invalid_client: 'OIDC 客户端凭证错误（clientId/clientSecret 不匹配）',
        invalid_redirect_uri: '回调地址(redirect_uri)与 IdP 注册的不一致',
        mismatching_state: 'state 校验失败，请重新发起',
      };
      const msg = friendly[errCode] ||
        (errCode ? `OIDC 提供商返回错误：${errCode}${errBody ? `（${errBody}）` : ''}` : 'OIDC 换 token 失败，请检查 IdP 配置');
      throw new BusinessError(msg, 502);
    }

    const idTokenClaims = tokenSet.claims() as any;
    const subject = idTokenClaims?.sub;
    if (!subject) {
      throw new BusinessError(`OIDC 提供商【${this.config.label}】未返回 subject`, 502);
    }

    // 优先用 id_token claims，必要时补充 fetchUserInfo（有些 IdP 把 group/email 放 userinfo 端点）
    let claims: any = idTokenClaims;
    try {
      const userInfo = await oc.fetchUserInfo(config, tokenSet.access_token, subject);
      claims = { ...claims, ...userInfo };
    } catch (e) {
      // userinfo 端点可选，失败时用 id_token claims 兜底
      logger.debug({ err: e, provider: this.name }, 'OIDC userinfo 端点获取失败，使用 id_token claims');
    }

    return {
      subject,
      username: claims.preferred_username || claims.name || claims.nickname || claims.username,
      displayName: claims.name || claims.given_name || claims.nickname,
      email: claims.email,
      phone: claims.phone || claims.phone_number,
      // 部门：IdP 自定义 claim，JIT 建号时按名称模糊匹配本地部门
      department: claims.department,
      // 工号：IdP 自定义 claim，写入本地用户 phone 字段旁的工号（如有专用字段）
      employeeId: claims.employee_id,
      groups: Array.isArray(claims.groups) ? claims.groups : undefined,
    };
  }
}
