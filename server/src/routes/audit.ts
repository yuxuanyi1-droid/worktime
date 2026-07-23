import { Router } from 'express';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { BusinessError } from '../utils/errors';
import {
  firstQueryValue,
  parseOptionalDateTime,
  parseOptionalPositiveInt,
  parsePagination,
  parseString,
} from '../utils/validation';

const router = Router();
const auditService = new AuditService();

router.use(authMiddleware);

// 获取审计日志 — 管理员或拥有审计查看权限的角色
router.get('/', requirePermission('system:audit:view'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const startDate = parseOptionalDateTime(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseOptionalDateTime(firstQueryValue(req.query.endDate), 'endDate');
    if (startDate && endDate && startDate > endDate) {
      throw new BusinessError('startDate不能晚于endDate');
    }
    const data = await auditService.getLogs({
      userId: parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId'),
      action: parseString(firstQueryValue(req.query.action), 'action', { max: 50 }),
      target: parseString(firstQueryValue(req.query.target), 'target', { max: 50 }),
      startDate,
      endDate,
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

export const auditRoutes = router;
