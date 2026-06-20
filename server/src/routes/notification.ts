import { Router } from 'express';
import { NotificationService } from '../services/notificationService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { parsePagination } from '../utils/validation';

const router = Router();
const notificationService = new NotificationService();

router.use(authMiddleware);

// 获取通知列表
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await notificationService.getByUser(req.user!.id, {
      isRead: req.query.isRead !== undefined ? req.query.isRead === 'true' : undefined,
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 获取未读数量
router.get('/unread-count', async (req: AuthRequest, res, next) => {
  try {
    const count = await notificationService.getUnreadCount(req.user!.id);
    res.json({ code: 0, data: { count } });
  } catch (error) {
    next(error);
  }
});

// 标记已读
router.put('/read', async (req: AuthRequest, res, next) => {
  try {
    const { ids } = req.body;
    await notificationService.markAsRead(req.user!.id, ids);
    res.json({ code: 0, message: '已标记已读' });
  } catch (error) {
    next(error);
  }
});

// 标记全部已读
router.put('/read-all', async (req: AuthRequest, res, next) => {
  try {
    await notificationService.markAllAsRead(req.user!.id);
    res.json({ code: 0, message: '已全部标记已读' });
  } catch (error) {
    next(error);
  }
});

// 删除通知
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await notificationService.delete(req.user!.id, Number(req.params.id));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

export const notificationRoutes = router;
