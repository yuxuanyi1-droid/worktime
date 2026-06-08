import { Router } from 'express';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/permission';

const router = Router();
const auditService = new AuditService();

router.use(authMiddleware);

// 获取审计日志 — 仅管理员
router.get('/', requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const data = await auditService.getLogs({
      userId: req.query.userId ? Number(req.query.userId) : undefined,
      action: req.query.action as string,
      target: req.query.target as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

export const auditRoutes = router;
