import crypto from 'crypto';
import { oidcConfig, OidcProviderConfig } from '../../config/auth';
import { BusinessError } from '../../utils/errors';
import { OidcProvider } from './provider';
import { OidcAdapter } from './oidcAdapter';
import { DingTalkAdapter } from './dingtalkAdapter';
import { SiamAdapter } from './siamAdapter';

/** provider 对外的展示信息（不含 secret） */
export interface ProviderDefinition {
  name: string;
  label: string;
  type: 'oidc' | 'dingtalk' | 'siam';
  /** 是否 JIT 自动建号——前端据此区分"直接登录"（true）和"需绑定"（false）*/
  jit?: boolean;
}

/** state 载荷：编码进 HMAC 签名的 token，跨授权→回调传递 */
export interface StatePayload {
  /** 模式：login（未登录用第三方账号登录）或 bind（已登录用户绑定第三方账号） */
  mode: 'login' | 'bind';
  /** provider id（如 'authentik'） */
  provider: string;
  /** 登录后跳转目标（前端路由，仅 mode=login 用） */
  redirect?: string;
  /** 绑定场景下，发起绑定的本地用户 id（回调时校验与当前登录用户一致） */
  userId?: number;
  /** nonce（标准 OIDC 用） */
  nonce?: string;
  /** 过期时间戳（毫秒） */
  exp: number;
}

const adapterCache = new Map<string, OidcProvider>();

/** 按 type 构造适配器（带缓存） */
function buildAdapter(name: string, config: OidcProviderConfig): OidcProvider {
  const cached = adapterCache.get(name);
  if (cached) return cached;
  let adapter: OidcProvider;
  if (config.type === 'dingtalk') {
    adapter = new DingTalkAdapter(name, config);
  } else if (config.type === 'siam') {
    adapter = new SiamAdapter(name, config);
  } else {
    adapter = new OidcAdapter(name, config);
  }
  adapterCache.set(name, adapter);
  return adapter;
}

/**
 * 取适配器实例。要求该 provider 已在环境变量配置且 enabled。
 * 未配置/enabled=false 抛 BusinessError。
 */
export function getProvider(name: string): OidcProvider {
  const config = oidcConfig.providers[name];
  if (!config || !config.enabled) {
    throw new BusinessError(`不支持的登录方式：${name}`, 400);
  }
  return buildAdapter(name, config);
}

/** 取 provider 的展示名（纯函数，供绑定列表等场景取 label） */
export function getProviderLabel(name: string): string {
  return oidcConfig.providers[name]?.label ?? name;
}

/**
 * 列出对用户可见的 provider（单层：环境变量 OIDC_PROVIDERS 中 enabled=true 的）。
 * 登录页 / 个人中心绑定区用这个渲染按钮。
 */
export function listVisibleProviders(): ProviderDefinition[] {
  return Object.entries(oidcConfig.providers)
    .filter(([, c]) => c.enabled)
    .map(([name, c]) => ({ name, label: c.label, type: c.type, jit: !!c.jit }));
}

/**
 * 校验 provider 是否已启用（环境变量里配了且 enabled=true）。
 * 未启用的 provider 直接拒绝，避免有人手动构造 URL 绕过。
 */
export function assertProviderVisible(name: string): void {
  const config = oidcConfig.providers[name];
  if (!config || !config.enabled) {
    throw new BusinessError(`该登录方式未开放：${name}`, 400);
  }
}

// ==================== state HMAC 签名 / 校验 ====================
// 无状态方案：把 StatePayload JSON + exp 用 HMAC 签名成 base64url 字符串，
// 作为 OAuth state 参数往返传递。回调时校验签名 + exp，无需 session/cookie。

export function signState(payload: Omit<StatePayload, 'exp'>): string {
  const full: StatePayload = { ...payload, exp: Date.now() + oidcConfig.stateTtlMs };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = hmac(body);
  return `${body}.${sig}`;
}

export function verifyState(token: string): StatePayload {
  const dot = token.lastIndexOf('.');
  if (dot < 1) throw new BusinessError('SSO state 无效', 400);
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(body))) {
    throw new BusinessError('SSO state 签名校验失败', 400);
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new BusinessError('SSO state 解析失败', 400);
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new BusinessError('SSO state 已过期，请重新发起登录', 400);
  }
  return payload;
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', oidcConfig.stateSecret).update(data).digest('base64url');
}

/** 定长字符串常量时间比较，防时序攻击 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
