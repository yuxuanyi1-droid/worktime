import { Router } from 'express';
import { NotificationService } from '../services/notificationService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  firstQueryValue,
  parseArray,
  parseOptionalBooleanQuery,
  parsePagination,
  parsePositiveInt,
} from '../utils/validation';

const router = Router();
const notificationService = new NotificationService();

router.use(authMiddleware);

// 获取通知列表
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await notificationService.getByUser(req.user!.id, {
      isRead: parseOptionalBooleanQuery(firstQueryValue(req.query.isRead), 'isRead'),
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
    const ids = parseArray(
      req.body?.ids,
      'ids',
      (id, index) => parsePositiveInt(id, `ids[${index}]`),
      { min: 1, max: 200 },
    );
    await notificationService.markAsRead(req.user!.id, [...new Set(ids)]);
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
    await notificationService.delete(req.user!.id, parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

export const notificationRoutes = router;
