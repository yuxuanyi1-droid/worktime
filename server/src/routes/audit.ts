import { Router } from 'express';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { firstQueryValue, parseOptionalPositiveInt, parsePagination } from '../utils/validation';

const router = Router();
const auditService = new AuditService();

router.use(authMiddleware);

// 获取审计日志 — 管理员或拥有审计查看权限的角色
router.get('/', requirePermission('system:audit:view'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await auditService.getLogs({
      userId: parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId'),
      action: firstQueryValue(req.query.action),
      target: firstQueryValue(req.query.target),
      startDate: firstQueryValue(req.query.startDate),
      endDate: firstQueryValue(req.query.endDate),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

export const auditRoutes = router;
