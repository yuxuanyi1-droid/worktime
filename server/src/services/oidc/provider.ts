import type { OidcProviderConfig } from '../../config/auth';

/** 从 IdP 换取到的标准化用户信息（适配器统一产出） */
export interface ProviderUserInfo {
  /** IdP 侧唯一标识（标准 OIDC 的 sub / 钉钉的 unionId）—— 身份匹配的唯一依据 */
  subject: string;
  /** IdP 侧登录名（preferred_username），作为本地 username 候选 */
  username?: string;
  /** IdP 侧真实姓名/显示名（name），作为本地 realName */
  displayName?: string;
  email?: string;
  /** 手机号（IdP 自定义 claim，JIT 建号时写入本地用户；钉钉无此概念） */
  phone?: string;
  /** 部门名称（IdP 自定义 claim，JIT 建号时按名称匹配本地部门；可能为多级路径如 "研发部-前端组"） */
  department?: string;
  /** 工号（IdP 自定义 claim，JIT 建号时写入本地用户） */
  employeeId?: string;
  /** IdP 侧分组列表（标准 OIDC 的 groups claim，用于角色映射；钉钉无此概念） */
  groups?: string[];
}

/**
 * 授权准备阶段生成的中间值（nonce），需由调用方编入 HMAC state 供回调复用。
 * 该值必须跨「发起授权 → IdP 回调」请求保留，因此存进 state 而非 session。
 *
 * 不使用 PKCE：本系统是后端 confidential client（持有 client_secret，认证由 secret 保证），
 * PKCE 是为无法安全保存 secret 的公开客户端（SPA/移动端）设计的保护，这里不需要。
 * 且实测某些 IdP（如 Authentik 部分版本）在 PKCE 校验上存在缺陷会导致 invalid_grant。
 */
export interface AuthPreparation {
  /** nonce（标准 OIDC 用；钉钉返回 undefined） */
  nonce?: string;
}

/**
 * 第三方登录提供商适配器统一接口。
 *
 * 授权流程拆成两步，state 由调用方（route 层）用 registry.signState 最终化：
 * 1. prepareAuth()：生成 nonce 等中间值（可能需要异步加载 openid-client 模块）
 * 2. getAuthorizationUrl(redirectUri, finalState, prep)：用最终 state + prep 拼 IdP 授权 URL
 *
 * - 标准 OIDC（Authentik/Keycloak/Okta）共用 OidcAdapter
 * - 钉钉等非标准 OAuth2 用专用适配器（DingTalkAdapter，prepareAuth 返回 undefined）
 *
 * 适配器只负责「生成 nonce」「拼授权 URL」「换 token 取用户信息」，
 * 不关心 state 签名/HMAC/本地用户绑定（这些由 registry / route 层负责）。
 */
export interface OidcProvider {
  /** provider id（如 'authentik'） */
  name: string;
  /** 原始配置 */
  config: OidcProviderConfig;
  /** 生成 nonce 中间值（回调时需从 state 回传给 getUserInfo） */
  prepareAuth(): Promise<AuthPreparation>;
  /** 用最终 state + prep 拼 IdP 授权 URL（state 由调用方已签好） */
  getAuthorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce?: string;
  }): Promise<string>;
  /** 用授权码换 token 并取用户信息 */
  getUserInfo(params: {
    code: string;
    state: string;
    redirectUri: string;
    nonce?: string;
  }): Promise<ProviderUserInfo>;
}
