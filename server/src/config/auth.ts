import './env'; // 加载仓库根 .env（含 JWT_SECRET；不依赖 server/.env）
import crypto from 'node:crypto';

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET 未配置，请在环境变量或 .env 中设置强随机密钥');
}
// 强度校验：拒绝已知弱密钥/占位符/过短密钥，防止生产误用。
// 占位符用「前缀匹配」拦截（如 .env.example 历史上的 replace-with-... 示例值），
// 避免运维照抄模板后占位符绕过精确匹配黑名单直接上线。
const WEAK_SECRET_PREFIXES = ['replace-with-', 'worktime-jwt-secret-key', 'your-secret-key'];
const WEAK_SECRETS = new Set(['secret', 'jwt-secret', 'changeme']);
if (WEAK_SECRETS.has(jwtSecret) || WEAK_SECRET_PREFIXES.some((prefix) => jwtSecret.startsWith(prefix))) {
  throw new Error('JWT_SECRET 是已知的弱密钥或占位符，请生成一个至少 32 字符的随机密钥（如 openssl rand -hex 32）');
}
if (jwtSecret.length < 32) {
  throw new Error(`JWT_SECRET 长度不足（${jwtSecret.length} 字符），请使用至少 32 字符的随机密钥`);
}

export const authConfig = {
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  /**
   * Refresh token 签名密钥。优先用独立的 JWT_REFRESH_SECRET（运维隔离两种 token 的签名密钥）；
   * 未配置时从 jwtSecret 派生（HMAC-sha256，域分离标签 'refresh-v1'），保证派生密钥足够强且与
   * access token / OIDC state 密钥互不相同——即使其中一项泄漏，攻击者也无法直接伪造另一种 token。
   * jwtSecret 已通过上方的强度校验（≥32 字符、非弱占位符），派生出的 HMAC 同样满足长度与熵要求，
   * 此处无需再重复 throw。
   */
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET
    || crypto.createHmac('sha256', jwtSecret).update('refresh-v1').digest('hex'),
  /** Refresh token 有效期，默认 7 天（远长于 access token 的 24h，保证长表单编辑中途不丢会话） */
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
};

// ==================== OIDC / 第三方登录配置 ====================
// Provider 定义层（运维配置）：在 server/.env 的 OIDC_PROVIDERS 中以 JSON 形式定义所有
// OIDC 提供商的连接参数（issuer/clientId/clientSecret 等）。
// 哪些提供商对用户可见，由管理员在控制台通过系统设置开关控制（见 SystemSetting.auth_oidc_enabled_providers）。
// 一个提供商必须同时满足「环境变量已配置且 enabled」+「管理员开关已勾选」才对用户可见。

/** 单个 OIDC 提供商的连接配置 */
export interface OidcProviderConfig {
  /** 环境变量层开关：运维控制是否加载该 provider（false 则完全不参与） */
  enabled: boolean;
  /** 展示名（如 "Authentik" / "钉钉" / "OPPO SIAM"），前端按钮文案 */
  label: string;
  /** 提供商类型：标准 OIDC / 钉钉（非标准 OAuth2）/ OPPO SIAM（直连 OAuth2） */
  type: 'oidc' | 'dingtalk' | 'siam';
  /**
   * 是否启用 JIT 自动建号（Just-In-Time provisioning）。
   * - true（主要登录方式）：登录时若 (provider, subject) 未绑定本地用户，自动创建本地用户并绑定。
   *   适用于 Authentik 这类"企业主身份源"——用户在 IdP 侧开通即获得系统访问权。
   * - false / 未设（补充登录方式）：未绑定时提示"请先账号密码登录后绑定"。适用于钉钉/SIAM 等辅助登录。
   */
  jit?: boolean;
  /** JIT 建号时新用户的默认角色名。默认 'employee'。角色由本地管理员后续手动调整 */
  defaultRole?: string;
  // ---- 标准 OIDC 字段（type === 'oidc'）----
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  // ---- 钉钉字段（type === 'dingtalk'）----
  dingtalk?: { clientId?: string; clientSecret?: string; scopes?: string[] };
  // ---- OPPO SIAM 字段（type === 'siam'）----
  /**
   * SIAM 直连模式基址，默认 https://sso.myoas.com。
   * authorize / accessTokenByJson / profileByJson / logout 均挂在该 host 下。
   */
  ssoBaseUrl?: string;
}

/** 解析 OIDC_PROVIDERS（JSON）。解析失败时回退为空对象，避免启动崩溃（SSO 是可选功能） */
function parseProviders(): Record<string, OidcProviderConfig> {
  const raw = process.env.OIDC_PROVIDERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    // 用 console 而非 logger，避免循环依赖（logger 可能间接引入 database）
    console.warn('[oidc] OIDC_PROVIDERS 解析失败，已忽略所有 OIDC 配置：', (e as Error).message);
    return {};
  }
}

export const oidcConfig = {
  /** 所有 provider 定义（环境变量层） */
  providers: parseProviders(),
  /**
   * state HMAC 签名密钥。优先用独立的 OIDC_STATE_SECRET；
   * 未配置时从 jwtSecret 派生（HMAC），实现密钥用途隔离，避免与 JWT 签名共用同一原值。
   */
  stateSecret: process.env.OIDC_STATE_SECRET || crypto.createHmac('sha256', jwtSecret).update('oidc-state-v1').digest('hex'),
  /** state 有效期（毫秒），默认 10 分钟 */
  stateTtlMs: 10 * 60 * 1000,
};
