import { Router } from 'express';
import { AnnouncementService } from '../services/announcementService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission, getUserOrgInfo } from '../middleware/permission';

const router = Router();
const announcementService = new AnnouncementService();

router.use(authMiddleware);

// ========== 管理端接口 ==========

// 获取公告列表（管理端）
router.get('/admin/list', requirePermission('system:announcement:view'), async (req: AuthRequest, res) => {
  try {
    const data = await announcementService.getList({
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 创建公告
router.post('/admin', requirePermission('system:announcement:create'), async (req: AuthRequest, res) => {
  try {
    const data = await announcementService.create({
      ...req.body,
      createdById: req.user!.id,
    });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 更新公告
router.put('/admin/:id', requirePermission('system:announcement:update'), async (req: AuthRequest, res) => {
  try {
    const data = await announcementService.update(Number(req.params.id), req.body);
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 删除公告
router.delete('/admin/:id', requirePermission('system:announcement:delete'), async (req: AuthRequest, res) => {
  try {
    await announcementService.delete(Number(req.params.id));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 获取公告已读统计
router.get('/admin/:id/stats', requirePermission('system:announcement:view'), async (req: AuthRequest, res) => {
  try {
    const data = await announcementService.getReadStats(Number(req.params.id));
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// ========== 用户端接口 ==========

// 获取用户可见公告列表
router.get('/my', async (req: AuthRequest, res) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    const data = await announcementService.getForUser(req.user!.id, orgInfo.departmentId, {
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
      isRead: req.query.isRead !== undefined ? req.query.isRead === 'true' : undefined,
    });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 获取用户未读公告数量
router.get('/my/unread-count', async (req: AuthRequest, res) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    const count = await announcementService.getUnreadCount(req.user!.id, orgInfo.departmentId);
    res.json({ code: 0, data: { count } });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 标记公告已读
router.put('/my/read/:id', async (req: AuthRequest, res) => {
  try {
    await announcementService.markAsRead(req.user!.id, Number(req.params.id));
    res.json({ code: 0, message: '已标记已读' });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 标记全部公告已读
router.put('/my/read-all', async (req: AuthRequest, res) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    await announcementService.markAllAsRead(req.user!.id, orgInfo.departmentId);
    res.json({ code: 0, message: '已全部标记已读' });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

export const announcementRoutes = router;
