import { Router } from 'express';
import { WeeklyReportService } from '../services/weeklyReportService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import {
  firstQueryValue,
  parseDateString,
  parseNonNegativeNumber,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';
import { canAccessUserData } from '../utils/accessControl';

const router = Router();
const weeklyReportService = new WeeklyReportService();

function parseWeeklyReportPayload(body: Record<string, unknown>) {
  return {
    weekStart: parseDateString(body.weekStart, 'weekStart'),
    weekEnd: parseDateString(body.weekEnd, 'weekEnd'),
    content: parseString(body.content, 'content', { max: 20000 }),
    summary: parseString(body.summary, 'summary', { max: 2000 }),
    totalDays: body.totalDays === undefined ? undefined : parseNonNegativeNumber(body.totalDays, 'totalDays', { max: 7 }),
  };
}

router.use(authMiddleware);

// 查看自己的周报
router.get('/my', requirePermission('weekly_report:view:self'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await weeklyReportService.getByUser(req.user!.id, {
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 查看指定周的周报
router.get('/week', requirePermission('weekly_report:view:self', 'weekly_report:view:group', 'weekly_report:view:department'), async (req: AuthRequest, res, next) => {
  try {
    const weekStart = parseDateString(firstQueryValue(req.query.weekStart), 'weekStart');
    const userId = firstQueryValue(req.query.userId)
      ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId')
      : req.user!.id;
    if (!await canAccessUserData(req.user!, userId, {
      departmentPermissions: ['weekly_report:view:department'],
      groupPermissions: ['weekly_report:view:group'],
    })) {
      return res.status(403).json({ code: 403, message: '只能查看自己或负责部门内成员的周报' });
    }
    const data = await weeklyReportService.getByWeek(userId, weekStart);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 创建/更新周报
router.post('/', requirePermission('weekly_report:create'), async (req: AuthRequest, res, next) => {
  try {
    const payload = parseWeeklyReportPayload(req.body as Record<string, unknown>);
    const data = await weeklyReportService.createOrUpdate({ ...payload, userId: req.user!.id });
    res.json({ code: 0, data, message: '保存成功' });
  } catch (error) {
    next(error);
  }
});

// 提交审批
router.post('/submit', requirePermission('weekly_report:submit:self'), async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.body.id, 'id');
    await weeklyReportService.submit(id, req.user!.id);
    res.json({ code: 0, message: '提交成功' });
  } catch (error) {
    next(error);
  }
});

export const weeklyReportRoutes = router;
