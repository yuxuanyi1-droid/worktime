import { Request, Router } from 'express';
import crypto from 'node:crypto';
import { AuthService } from '../services/authService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getRedis, isRedisReady } from '../config/redis';
import { isBusinessError } from '../utils/errors';
import { parseString } from '../utils/validation';

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
    if (await getLoginFailureCount(loginKey) >= MAX_LOGIN_FAILURES) {
      return res.status(429).json({ code: 429, message: '登录失败次数过多，请稍后再试' });
    }

    const result = await authService.login(username, password);
    await clearLoginFailures(loginKey);
    // 审计日志
    auditService.log({ userId: result.user.id, action: 'login', target: 'system', ip: req.ip });
    res.json({ code: 0, data: result, message: '登录成功' });
  } catch (error: any) {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (username && isBusinessError(error) && error.statusCode < 500) {
      const loginKey = getLoginKey(req, username);
      await recordLoginFailure(loginKey);
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
      email: parseString(body.email, '邮箱', { max: 100 }),
      phone: parseString(body.phone, '手机', { max: 20 }),
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
    await authService.changePassword(req.user!.id, oldPassword, newPassword);
    auditService.log({ userId: req.user!.id, action: 'change_password', target: 'user', targetId: req.user!.id, ip: req.ip });
    res.json({ code: 0, message: '密码修改成功' });
  } catch (error) {
    next(error);
  }
});

export const authRoutes = router;
