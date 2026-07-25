import { Request, Router } from 'express';
import crypto from 'node:crypto';
import { AuthService } from '../services/authService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getRedis, isRedisReady } from '../config/redis';
import { isBusinessError } from '../utils/errors';
import { parseOptionalEmail, parseOptionalPhone, parseString } from '../utils/validation';

const router = Router();
const authService = new AuthService();
const auditService = new AuditService();

const loginFailures = new Map<string, { count: number; lastFailedAt: number }>();
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function getLoginKey(req: Request, username: string) {
  return crypto
    .createHash('sha256')
    .update(`${req.ip || 'unknown'}\0${username.toLowerCase()}`)
    .digest('hex');
}

/** 仅按用户名的锁定 key：防止攻击者轮换 X-Forwarded-For 绕过 IP 维度锁定、针对单一账号爆破。 */
function getUsernameKey(username: string) {
  return crypto.createHash('sha256').update(`u\0${username.toLowerCase()}`).digest('hex');
}

function pruneLoginFailures(now = Date.now()) {
  for (const [key, failure] of loginFailures.entries()) {
    if (now - failure.lastFailedAt > LOGIN_LOCK_MS) {
      loginFailures.delete(key);
    }
  }
}

async function getLoginFailureCount(key: string): Promise<number> {
  const redis = getRedis();
  if (redis?.isReady && isRedisReady()) {
    try {
      return Number(await redis.get(`worktime:auth:login-fail:${key}`)) || 0;
    } catch { /* 回退本实例内存 */ }
  }
  pruneLoginFailures();
  return loginFailures.get(key)?.count || 0;
}

async function recordLoginFailure(key: string): Promise<void> {
  const redis = getRedis();
  if (redis?.isReady && isRedisReady()) {
    try {
      await redis.multi()
        .incr(`worktime:auth:login-fail:${key}`)
        .expire(`worktime:auth:login-fail:${key}`, Math.ceil(LOGIN_LOCK_MS / 1000))
        .exec();
      return;
    } catch { /* 回退本实例内存 */ }
  }
  const current = loginFailures.get(key);
  loginFailures.set(key, { count: (current?.count || 0) + 1, lastFailedAt: Date.now() });
}

async function clearLoginFailures(key: string): Promise<void> {
  loginFailures.delete(key);
  const redis = getRedis();
  if (redis?.isReady && isRedisReady()) {
    await redis.del(`worktime:auth:login-fail:${key}`).catch(() => 0);
  }
}

router.post('/login', async (req, res, next) => {
  try {
    const username = parseString(req.body?.username, '用户名', { required: true, max: 50 })!;
    const password = parseString(req.body?.password, '密码', { required: true, max: 128, trim: false })!;

    const loginKey = getLoginKey(req, username);
    const userKey = getUsernameKey(username);
    // 双 key 锁定：IP+username 防分散爆破，username-only 防针对单一账号的 XFF 轮换绕过
    if ((await getLoginFailureCount(loginKey)) >= MAX_LOGIN_FAILURES
      || (await getLoginFailureCount(userKey)) >= MAX_LOGIN_FAILURES) {
      return res.status(429).json({ code: 429, message: '登录失败次数过多，请稍后再试' });
    }

    const result = await authService.login(username, password);
    await Promise.all([clearLoginFailures(loginKey), clearLoginFailures(userKey)]);
    // 审计日志
    auditService.log({ userId: result.user.id, action: 'login', target: 'system', ip: req.ip });
    res.json({ code: 0, data: result, message: '登录成功' });
  } catch (error: any) {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (username && isBusinessError(error) && error.statusCode < 500) {
      await Promise.all([
        recordLoginFailure(getLoginKey(req, username)),
        recordLoginFailure(getUsernameKey(username)),
      ]);
    }
    next(error);
  }
});

router.post('/logout', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    await authService.logout(req.user!.id);
    auditService.log({ userId: req.user!.id, action: 'logout', target: 'system', ip: req.ip });
    res.json({ code: 0, message: '已登出' });
  } catch (error) {
    next(error);
  }
});

/**
 * 刷新 Access Token：用 Refresh Token 换取新的短期 Access Token。
 *
 * - 不走 authMiddleware（refresh token 自带身份+版本，无需 access token 鉴权）。
 * - 不走登录失败锁定逻辑（/refresh 与 /login 是不同路径，锁定仅作用在 /login）。
 * - 校验失败（过期/版本不符/用户禁用）由 authService 抛 BusinessError(401)，经 next(error) 统一处理。
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const refreshToken = parseString(req.body?.refreshToken, 'refreshToken', { required: true, max: 2048, trim: false })!;
    const token = await authService.refreshAccessToken(refreshToken);
    res.json({ code: 0, data: { token } });
  } catch (error) {
    next(error);
  }
});

router.get('/profile', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const profile = await authService.getProfile(req.user!.id);
    res.json({ code: 0, data: profile });
  } catch (error) {
    next(error);
  }
});

router.put('/profile', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const data = await authService.updateProfile(req.user!.id, {
      realName: body.realName === undefined ? undefined : parseString(body.realName, '姓名', { required: true, max: 50 }),
      email: parseOptionalEmail(body.email, '邮箱'),
      phone: parseOptionalPhone(body.phone, '手机号'),
    });
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/change-password', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const oldPassword = parseString(req.body?.oldPassword, '原密码', { required: true, max: 128, trim: false })!;
    const newPassword = parseString(req.body?.newPassword, '新密码', { required: true, min: 8, max: 128, trim: false })!;
    // 密码复杂度：至少包含大写、小写、数字、特殊字符中的 3 类，避免弱口令
    const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(newPassword)).length;
    if (categories < 3) {
      return res.status(400).json({ code: 400, message: '新密码需至少包含大写字母、小写字母、数字、特殊字符中的 3 种' });
    }
    await authService.changePassword(req.user!.id, oldPassword, newPassword);
    auditService.log({ userId: req.user!.id, action: 'change_password', target: 'user', targetId: req.user!.id, ip: req.ip });
    res.json({ code: 0, message: '密码修改成功' });
  } catch (error) {
    next(error);
  }
});

export const authRoutes = router;
