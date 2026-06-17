import { Request, Router } from 'express';
import { AuthService } from '../services/authService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const authService = new AuthService();
const auditService = new AuditService();

const loginFailures = new Map<string, { count: number; lockedUntil?: number; lastFailedAt: number }>();
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getLoginKey(req: Request, username: string) {
  return `${req.ip || 'unknown'}:${String(username).toLowerCase()}`;
}

function pruneLoginFailures(now = Date.now()) {
  for (const [key, failure] of loginFailures.entries()) {
    const isStale = now - failure.lastFailedAt > LOGIN_FAILURE_CACHE_TTL_MS;
    const lockExpired = failure.lockedUntil !== undefined && failure.lockedUntil <= now;
    if (isStale || lockExpired) {
      loginFailures.delete(key);
    }
  }
}

router.post('/login', async (req, res, next) => {
  try {
    pruneLoginFailures();
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ code: 400, message: '用户名和密码不能为空' });
    }

    const loginKey = getLoginKey(req, username);
    const failure = loginFailures.get(loginKey);
    if (failure?.lockedUntil && failure.lockedUntil > Date.now()) {
      return res.status(429).json({ code: 429, message: '登录失败次数过多，请稍后再试' });
    }

    const result = await authService.login(username, password);
    loginFailures.delete(loginKey);
    // 审计日志
    auditService.log({ userId: result.user.id, action: 'login', target: 'system', ip: req.ip });
    res.json({ code: 0, data: result, message: '登录成功' });
  } catch (error: any) {
    const username = req.body?.username;
    if (username) {
      const loginKey = getLoginKey(req, username);
      const current = loginFailures.get(loginKey);
      const nextCount = (current?.count || 0) + 1;
      loginFailures.set(loginKey, {
        count: nextCount,
        lockedUntil: nextCount >= MAX_LOGIN_FAILURES ? Date.now() + LOGIN_LOCK_MS : undefined,
        lastFailedAt: Date.now(),
      });
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
    const data = await authService.updateProfile(req.user!.id, req.body);
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/change-password', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    await authService.changePassword(req.user!.id, oldPassword, newPassword);
    auditService.log({ userId: req.user!.id, action: 'change_password', target: 'user', targetId: req.user!.id, ip: req.ip });
    res.json({ code: 0, message: '密码修改成功' });
  } catch (error) {
    next(error);
  }
});

export const authRoutes = router;
