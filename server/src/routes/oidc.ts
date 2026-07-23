import { Router, Response } from 'express';
import { AuthService } from '../services/authService';
import { ExternalIdentityService } from '../services/externalIdentityService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { BusinessError } from '../utils/errors';
import { logger } from '../utils/logger';
import { oidcCallbackLimiter } from '../middleware/security';
import { buildFixedRedirectUri, buildTrustedRedirectUri, safeInternalRedirect } from '../services/oidc/redirectUri';
import {
  getProvider,
  listVisibleProviders,
  assertProviderVisible,
  signState,
  verifyState,
} from '../services/oidc/registry';
import { parseString } from '../utils/validation';

const router = Router();
const authService = new AuthService();
const identityService = new ExternalIdentityService();
const auditService = new AuditService();

/**
 * 将“成功调用 next / 中间件已自行响应”都收敛成可 await 的结果，避免认证失败时 Promise 永久悬挂。
 */
export function runAuthMiddleware(req: AuthRequest, res: Response): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
    res.once('finish', finish);
    authMiddleware(req, res, (error?: unknown) => {
      if (settled) return;
      settled = true;
      res.off('finish', finish);
      if (error) reject(error);
      else resolve(true);
    });
  });
}

/**
 * 推断前端回调页地址（用于构造 OAuth redirect_uri，回指前端 /oidc/callback 页面）。
 *
 * dev 下前后端分端口（前端 5174、后端 3001），前端经 vite proxy 调后端，
 * 此时后端拿到的 host 是后端端口，不能用作 redirect_uri。
 * 因此优先用前端显式传入的 redirectUriBase（query 或 body），兜底才用请求自身 host。
 * 生产前后端同域时，兜底 host 即正确值。
 */
function deriveRedirectUri(req: AuthRequest): string {
  const fixedOrigin = process.env.OIDC_REDIRECT_ORIGIN?.trim();
  if (fixedOrigin) {
    return buildFixedRedirectUri(fixedOrigin, process.env.BASE_PATH || '');
  }

  const base = parseString(
    req.query.redirectUriBase ?? req.body?.redirectUriBase,
    'redirectUriBase',
    { max: 2048 },
  );
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  const requestOrigin = `${proto}://${host}`;
  const clientPort = process.env.CLIENT_PORT || '5173';
  const configuredOrigins = (process.env.OIDC_REDIRECT_ORIGINS || process.env.ALLOWED_ORIGINS ||
    `http://localhost:${clientPort},http://127.0.0.1:${clientPort}`).split(',');

  // 开发/测试环境允许当前 Host，便于 Vite 分端口运行；生产必须来自显式允许列表，
  // 防止攻击者通过伪造 Host + redirectUriBase 把授权码导向任意域名。
  const trustRequestOrigin = process.env.NODE_ENV !== 'production';
  return buildTrustedRedirectUri(base || requestOrigin, requestOrigin, configuredOrigins, trustRequestOrigin);
}

// ========== 公开端点 ==========

/**
 * 列出对用户可见的 OIDC 提供商（环境变量 OIDC_PROVIDERS 中 enabled=true 的）。
 * 公开（无 authMiddleware）—— 登录页未登录时靠它渲染按钮。
 */
router.get('/providers', (_req, res) => {
  res.json({ code: 0, data: listVisibleProviders() });
});

// ========== 登录/绑定发起（跳转 IdP） ==========

/**
 * 发起 OIDC 授权：生成 state → 跳转 IdP 授权页。
 *
 * mode=login（默认）：未登录用户用第三方账号登录。公开。
 * mode=bind：已登录用户绑定第三方账号。必须带登录态（下方中间件强制）。
 *
 * query:
 *   - mode: 'login' | 'bind'（默认 login）
 *   - redirect: 登录成功后前端跳转目标（仅 mode=login 用，默认 '/'）
 *   - redirectUriBase: 前端基地址（如 https://app.example.com/worktime），用于构造 OAuth redirect_uri
 */
router.get('/:provider/login', async (req: AuthRequest, res: Response, next) => {
  try {
    const provider = parseString(req.params.provider, 'provider', { required: true, max: 50 })!;
    const mode = (req.query.mode as string) === 'bind' ? 'bind' : 'login';

    // bind 模式必须有登录态
    if (mode === 'bind') {
      const authenticated = await runAuthMiddleware(req, res);
      if (!authenticated || !req.user) return;
    }

    // 两层可见性校验：未开放的 provider 拒绝（防绕过开关）
    assertProviderVisible(provider);

    const redirectUri = deriveRedirectUri(req);
    const redirectTarget = safeInternalRedirect(parseString(req.query.redirect, 'redirect', { max: 500 }));
    const adapter = getProvider(provider);
    logger.info({ provider, mode, redirectUri, redirectUriBase: req.query.redirectUriBase }, 'OIDC 发起授权');

    // 两步：先生成 PKCE/nonce（适配器内部，可能需异步加载 openid-client）
    const prep = await adapter.prepareAuth();

    // 把 mode/provider/redirect/userId + nonce 全部编入 HMAC state（回调时解出复用）
    const statePayload: any = {
      mode,
      provider,
      redirect: redirectTarget,
      nonce: prep.nonce,
    };
    if (mode === 'bind' && req.user) {
      statePayload.userId = req.user.id;
    }
    const finalState = signState(statePayload);

    // 用最终 state 拼 IdP 授权 URL
    const authUrl = await adapter.getAuthorizationUrl({
      redirectUri,
      state: finalState,
      nonce: prep.nonce,
    });

    auditService.log({
      userId: req.user?.id,
      action: mode === 'bind' ? 'oidc_bind_start' : 'oidc_login_start',
      target: 'system',
      detail: provider,
      ip: req.ip,
    });

    // 返回 JSON（不直接 302），前端拿到 url 后自行 window.location 跳转，
    // 同时可在跳转前把 mode/redirect 存 sessionStorage 供回调页判断意图。
    res.json({ code: 0, data: { url: authUrl } });
  } catch (error) {
    next(error);
  }
});

// ========== 回调处理 ==========

/**
 * OIDC 回调：前端从 IdP 回跳后，把 code+state POST 给这里换取本地 token 或完成绑定。
 *
 * body: { code, state }
 * - state.mode === 'login': 查绑定 → 签发本地 JWT → 返回 { token, user }
 * - state.mode === 'bind':  需带 Authorization，且 state.userId === 当前用户 → 写绑定表
 */
router.post('/:provider/callback', oidcCallbackLimiter, async (req: AuthRequest, res, next) => {
  try {
    const provider = parseString(req.params.provider, 'provider', { required: true, max: 50 })!;
    const code = parseString(req.body?.code, 'code', { required: true, max: 4096 })!;
    const state = parseString(req.body?.state, 'state', { required: true, max: 8192 })!;

    const statePayload = verifyState(state);
    if (statePayload.provider !== provider) {
      throw new BusinessError('state 中的 provider 与请求不匹配', 400);
    }
    // 回调阶段再次校验可见性（管理员可能在授权期间关闭了开关）
    assertProviderVisible(provider);

    let bindUserId: number | undefined;
    if (statePayload.mode === 'bind') {
      // 在向 IdP 交换授权码前完成本地登录态和发起者校验。
      const authenticated = await runAuthMiddleware(req, res);
      if (!authenticated || !req.user) return;
      if (statePayload.userId !== req.user.id) {
        throw new BusinessError('绑定发起者与当前登录用户不一致', 403);
      }
      bindUserId = req.user.id;
    }

    const redirectUri = deriveRedirectUri(req);
    const adapter = getProvider(provider);
    logger.info({ provider, mode: statePayload.mode, redirectUri, redirectUriBase: req.body?.redirectUriBase }, 'OIDC 回调换 token');
    const info = await adapter.getUserInfo({
      code,
      state,
      redirectUri,
      nonce: statePayload.nonce,
    });

    if (statePayload.mode === 'bind') {
      const identity = await identityService.bind(bindUserId!, provider, info);
      auditService.log({
        userId: bindUserId,
        action: 'oidc_bind',
        target: 'user_external_identity',
        targetId: identity.id,
        detail: provider,
        ip: req.ip,
      });
      res.json({
        code: 0,
        data: {
          provider,
          providerLabel: adapter.config.label,
          externalUsername: identity.externalUsername,
        },
        message: '绑定成功',
      });
      return;
    }

    // 登录模式
    const result = await authService.oidcLogin(provider, info);
    auditService.log({
      userId: result.user.id,
      action: 'oidc_login',
      target: 'system',
      detail: provider,
      ip: req.ip,
    });
    res.json({
      code: 0,
      data: { ...result, redirect: safeInternalRedirect(statePayload.redirect) },
      message: '登录成功',
    });
  } catch (error) {
    next(error);
  }
});

// ========== 当前用户的绑定管理 ==========

/** 列出当前用户的全部第三方账号绑定 */
router.get('/bindings', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const list = await identityService.listBindings(req.user!.id);
    res.json({ code: 0, data: list });
  } catch (error) {
    next(error);
  }
});

/** 解绑当前用户的指定 provider */
router.delete('/bindings/:provider', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const provider = parseString(req.params.provider, 'provider', { required: true, max: 50 })!;
    await identityService.unbind(req.user!.id, provider);
    auditService.log({
      userId: req.user!.id,
      action: 'oidc_unbind',
      target: 'user_external_identity',
      detail: provider,
      ip: req.ip,
    });
    res.json({ code: 0, message: '已解绑' });
  } catch (error) {
    next(error);
  }
});

export const oidcRoutes = router;
