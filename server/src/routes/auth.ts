import { Request, Router } from 'express';
import { AuthService } from '../services/authService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { AppDataSource } from '../config/database';
import { LoginAttempt } from '../entities/LoginAttempt';
import { permissionImplications, legacyPermissionAliases } from '../config/permissionDefinitions';

const router = Router();
const authService = new AuthService();
const auditService = new AuditService();
const loginAttemptRepo = () => AppDataSource.getRepository(LoginAttempt);

const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

function getLoginKey(req: Request, username: string) {
  return `${req.ip || 'unknown'}:${String(username).toLowerCase()}`;
}

/**
 * 清理过期的失败记录（锁定已过期或长期未再失败的）。
 * 持久化实现下表会随时间增长，登录时顺手清理一次避免膨胀。
 */
async function pruneLoginAttempts(now = Date.now()) {
  await loginAttemptRepo().createQueryBuilder()
    .delete()
    .where('(lockedUntil IS NOT NULL AND lockedUntil < :now)', { now })
    .orWhere('lastFailedAt < :cutoff', { cutoff: now - LOGIN_FAILURE_TTL_MS })
    .execute();
}

router.post('/login', async (req, res, next) => {
  try {
    await pruneLoginAttempts();
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ code: 400, message: '用户名和密码不能为空' });
    }

    const loginKey = getLoginKey(req, username);
    // 检查是否处于锁定窗口
    const attempt = await loginAttemptRepo().findOne({ where: { loginKey } });
    if (attempt?.lockedUntil && attempt.lockedUntil > Date.now()) {
      return res.status(429).json({ code: 429, message: '该账号登录失败次数过多，已临时锁定，请 15 分钟后再试' });
    }

    const result = await authService.login(username, password);
    // 登录成功：清除该 key 的失败记录
    if (attempt) await loginAttemptRepo().delete({ loginKey });
    // 审计日志
    auditService.log({ userId: result.user.id, action: 'login', target: 'system', ip: req.ip });
    res.json({ code: 0, data: result, message: '登录成功' });
  } catch (error: any) {
    const username = req.body?.username;
    if (username) {
      const loginKey = getLoginKey(req, username);
      const now = Date.now();
      // 原子 UPSERT + 自增：用原生 SQL 的 ON CONFLICT 让 failCount = failCount + 1，
      // 避免应用层「读 count → +1 → 写」在并发请求间丢失计数。
      // 注意：TypeORM 0.3.x 的 queryBuilder.orUpdate 不支持 SET 表达式（会把整串当列名），
      // 故改用原生 SQL。better-sqlite3 同步串行化执行，保证自增原子。
      // 一并在 SET 中用 CASE 处理锁定：累加后达到阈值则设置 lockedUntil，否则保留原值。
      await AppDataSource.query(
        `INSERT INTO "login_attempts" ("loginKey", "failCount", "lockedUntil", "lastFailedAt")
         VALUES (?, 1, CASE WHEN 1 >= ? THEN ? ELSE NULL END, ?)
         ON CONFLICT("loginKey") DO UPDATE SET
           "failCount" = "login_attempts"."failCount" + 1,
           "lastFailedAt" = excluded."lastFailedAt",
           "lockedUntil" = CASE
             WHEN ("login_attempts"."failCount" + 1) >= ? AND ("login_attempts"."lockedUntil" IS NULL OR "login_attempts"."lockedUntil" < ?)
             THEN ?
             ELSE "login_attempts"."lockedUntil"
           END`,
        [loginKey, MAX_LOGIN_FAILURES, now + LOGIN_LOCK_MS, now, MAX_LOGIN_FAILURES, now, now + LOGIN_LOCK_MS],
      );
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

// 权限模型：后端为权威源（permissionDefinitions.ts），前端通过本端点拉取 implications/aliases，
// 消除前后端各维护一份硬编码副本导致的漂移风险。已登录用户可读（模型本身不含敏感数据）。
router.get('/permission-model', authMiddleware, (_req, res) => {
  res.json({
    code: 0,
    data: {
      implications: permissionImplications,
      aliases: legacyPermissionAliases,
    },
  });
});

export const authRoutes = router;
