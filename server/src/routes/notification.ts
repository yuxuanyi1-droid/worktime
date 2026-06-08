import { Router } from 'express';
import { NotificationService } from '../services/notificationService';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const notificationService = new NotificationService();

router.use(authMiddleware);

// 获取通知列表
router.get('/', async (req: AuthRequest, res) => {
  try {
    const data = await notificationService.getByUser(req.user!.id, {
      isRead: req.query.isRead !== undefined ? req.query.isRead === 'true' : undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 获取未读数量
router.get('/unread-count', async (req: AuthRequest, res) => {
  try {
    const count = await notificationService.getUnreadCount(req.user!.id);
    res.json({ code: 0, data: { count } });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 标记已读
router.put('/read', async (req: AuthRequest, res) => {
  try {
    const { ids } = req.body;
    await notificationService.markAsRead(req.user!.id, ids);
    res.json({ code: 0, message: '已标记已读' });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 标记全部已读
router.put('/read-all', async (req: AuthRequest, res) => {
  try {
    await notificationService.markAllAsRead(req.user!.id);
    res.json({ code: 0, message: '已全部标记已读' });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

// 删除通知
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    await notificationService.delete(req.user!.id, Number(req.params.id));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

export const notificationRoutes = router;
