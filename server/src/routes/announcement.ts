import { Router } from 'express';
import { AnnouncementService } from '../services/announcementService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission, getUserOrgInfo } from '../middleware/permission';
import { parsePagination } from '../utils/validation';

const router = Router();
const announcementService = new AnnouncementService();

router.use(authMiddleware);

// ========== 管理端接口 ==========

// 获取公告列表（管理端）
router.get('/admin/list', requirePermission('system:announcement:view'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await announcementService.getList({ page, pageSize });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 创建公告
router.post('/admin', requirePermission('system:announcement:create'), async (req: AuthRequest, res, next) => {
  try {
    const data = await announcementService.create({
      ...req.body,
      createdById: req.user!.id,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 更新公告
router.put('/admin/:id', requirePermission('system:announcement:update'), async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const data = await announcementService.update(Number(req.params.id), req.body, user.id, user.roles.includes('admin'));
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 删除公告
router.delete('/admin/:id', requirePermission('system:announcement:delete'), async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    await announcementService.delete(Number(req.params.id), user.id, user.roles.includes('admin'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// 获取公告已读统计
router.get('/admin/:id/stats', requirePermission('system:announcement:view'), async (req: AuthRequest, res, next) => {
  try {
    const data = await announcementService.getReadStats(Number(req.params.id));
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// ========== 用户端接口 ==========

// 获取用户可见公告列表
router.get('/my', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const orgInfo = await getUserOrgInfo(req.user!.id);
    const data = await announcementService.getForUser(req.user!.id, orgInfo.departmentId, {
      page,
      pageSize,
      isRead: req.query.isRead !== undefined ? req.query.isRead === 'true' : undefined,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 获取用户未读公告数量
router.get('/my/unread-count', async (req: AuthRequest, res, next) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    const count = await announcementService.getUnreadCount(req.user!.id, orgInfo.departmentId);
    res.json({ code: 0, data: { count } });
  } catch (error) {
    next(error);
  }
});

// 标记公告已读
router.put('/my/read/:id', async (req: AuthRequest, res, next) => {
  try {
    await announcementService.markAsRead(req.user!.id, Number(req.params.id));
    res.json({ code: 0, message: '已标记已读' });
  } catch (error) {
    next(error);
  }
});

// 标记全部公告已读
router.put('/my/read-all', async (req: AuthRequest, res, next) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    await announcementService.markAllAsRead(req.user!.id, orgInfo.departmentId);
    res.json({ code: 0, message: '已全部标记已读' });
  } catch (error) {
    next(error);
  }
});

export const announcementRoutes = router;
