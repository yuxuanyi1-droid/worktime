import { safeInternalRedirect } from './navigation';

export interface OidcIntent {
  mode: 'login' | 'bind';
  provider: string;
  redirect?: string;
  createdAt: number;
}

const STORAGE_KEY = 'oidc_pending_intent';
const INTENT_TTL_MS = 15 * 60 * 1000;
const PROVIDER_RE = /^[A-Za-z0-9._-]{1,50}$/;

/**
 * 保存一次性 SSO 意图。真正的 mode/provider/redirect 仍由服务端签名 state 决定；
 * 这里仅用于让公共回调页知道应调用哪个 provider，并选择合适的恢复页面。
 */
export function setOidcIntent(intent: Omit<OidcIntent, 'createdAt'>): void {
  const provider = intent.provider.trim();
  if (!PROVIDER_RE.test(provider)) throw new Error('OIDC provider 标识无效');
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
    mode: intent.mode,
    provider,
    redirect: intent.mode === 'login' ? safeInternalRedirect(intent.redirect) : undefined,
    createdAt: Date.now(),
  } satisfies OidcIntent));
}

export function clearOidcIntent(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 浏览器禁用存储时保持无状态；调用方会在回调页提示重新发起。
  }
}

/** 读取并立即删除一次性意图，防止刷新或重复回调再次提交同一个授权码。 */
export function takeOidcIntent(now = Date.now()): OidcIntent | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  } finally {
    clearOidcIntent();
  }
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<OidcIntent>;
    if (
      (value.mode !== 'login' && value.mode !== 'bind') ||
      typeof value.provider !== 'string' ||
      !PROVIDER_RE.test(value.provider) ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > now + 60_000 ||
      now - value.createdAt > INTENT_TTL_MS ||
      (value.redirect !== undefined && typeof value.redirect !== 'string')
    ) {
      return null;
    }
    return {
      mode: value.mode,
      provider: value.provider,
      redirect: value.mode === 'login' ? safeInternalRedirect(value.redirect) : undefined,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

/** dev 前后端分端口时必须把前端 origin + 部署子路径显式传给后端。 */
export function getRedirectUriBase(): string {
  return `${window.location.origin}${__BASE_PATH__ || ''}`;
}
