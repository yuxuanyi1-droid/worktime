import { Router } from 'express';
import { PatService } from '../services/patService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const patService = new PatService();
const auditService = new AuditService();

// PAT 管理本身只走 JWT 会话鉴权（不能用 PAT 管 PAT，避免令牌自管带来的循环依赖）
router.use(authMiddleware);

/** 列出当前用户所有 PAT（含明文，方便用户复制） */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const list = await patService.listMine(req.user!.id);
    res.json({ code: 0, data: list });
  } catch (error) {
    next(error);
  }
});

/** 创建新 PAT */
router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name, expiresAt } = req.body || {};
    // expiresAt 可选：ISO 字符串转 Date；空字符串/未传 = 永不过期
    let expire: Date | undefined;
    if (expiresAt && String(expiresAt).trim()) {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ code: 400, message: '过期时间格式无效' });
      }
      expire = d;
    }
    const pat = await patService.createMine(req.user!.id, name, expire);
    auditService.log({
      userId: req.user!.id,
      action: 'pat:create',
      target: 'personal_access_token',
      targetId: pat.id,
      detail: pat.name,
      ip: req.ip,
    });
    res.json({ code: 0, data: pat, message: '令牌已创建' });
  } catch (error) {
    next(error);
  }
});

/** 删除 PAT（仅限本人） */
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ code: 400, message: '令牌 ID 无效' });
    }
    await patService.deleteMine(req.user!.id, id);
    auditService.log({
      userId: req.user!.id,
      action: 'pat:delete',
      target: 'personal_access_token',
      targetId: id,
      ip: req.ip,
    });
    res.json({ code: 0, message: '令牌已删除' });
  } catch (error) {
    next(error);
  }
});

export const patRoutes = router;
