import { Router } from 'express';
import { OvertimeService } from '../services/overtimeService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireAllPermissions, requirePermission } from '../middleware/permission';
import {
  assertDateRange,
  firstQueryValue,
  parseArray,
  parseDateString,
  parseEnum,
  parseDays,
  parseOptionalDateString,
  parseOptionalEnum,
  parseOptionalPositiveInt,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';
import { BusinessError } from '../utils/errors';

const router = Router();
const overtimeService = new OvertimeService();
const overtimeStatuses = ['draft', 'submitted', 'approved', 'rejected', 'withdrawn'] as const;
const overtimeTypes = ['weekend', 'holiday', 'weekday'] as const;

function parseOvertimePayload(body: Record<string, unknown>, partial = false) {
  return {
    date: partial && body.date === undefined ? undefined : parseDateString(body.date, 'date'),
    overtimeType: partial && body.overtimeType === undefined
      ? undefined
      : partial
      ? parseOptionalEnum(body.overtimeType, 'overtimeType', overtimeTypes)
      : parseEnum(body.overtimeType, 'overtimeType', overtimeTypes),
    days: partial && body.days === undefined ? undefined : parseDays(body.days),
    reason: parseString(body.reason, 'reason', { max: 1000 }),
    projectId: partial
      ? parseOptionalPositiveInt(body.projectId, 'projectId')
      : parsePositiveInt(body.projectId, 'projectId'),
  };
}

router.use(authMiddleware);

// 查看自己的加班
router.get('/my', requirePermission('overtime:view:self'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const startDate = parseOptionalDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseOptionalDateString(firstQueryValue(req.query.endDate), 'endDate');
    assertDateRange(startDate, endDate);
    const data = await overtimeService.getByUser(req.user!.id, {
      startDate,
      endDate,
      status: parseOptionalEnum(firstQueryValue(req.query.status), 'status', overtimeStatuses),
      page,
      pageSize,
    });
    res.json({ code: 0, data: { ...data, list: data.list.map((r: any) => ({
      ...r,
      project: r.project ? { id: r.project.id, name: r.project.name } : null,
    })) } });
  } catch (error) {
    next(error);
  }
});

// 加班统计
router.get('/stats', requirePermission('overtime:view:self'), async (req: AuthRequest, res, next) => {
  try {
    const year = firstQueryValue(req.query.year)
      ? parsePositiveInt(firstQueryValue(req.query.year), 'year', { max: 9999 })
      : new Date().getFullYear();
    const month = parseOptionalPositiveInt(firstQueryValue(req.query.month), 'month', { max: 12 });
    const data = await overtimeService.getStats(req.user!.id, year, month);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 创建加班
router.post('/', requirePermission('overtime:create'), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const payload = parseOvertimePayload(body);
    const data = await overtimeService.create({ ...payload, userId: req.user!.id });
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

// 创建并直接提交审批
router.post('/submit-new', requireAllPermissions('overtime:create', 'overtime:submit:self'), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const payload = parseOvertimePayload(body);
    const data = await overtimeService.createAndSubmit({ ...payload, userId: req.user!.id });
    res.json({ code: 0, data, message: '提交成功' });
  } catch (error) {
    next(error);
  }
});

// 更新加班
router.put('/:id', requirePermission('overtime:update:self'), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const data = await overtimeService.update(
      parsePositiveInt(req.params.id, 'id'),
      req.user!.id,
      parseOvertimePayload(body, true),
    );
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

// 删除加班
router.delete('/:id', requirePermission('overtime:delete:self'), async (req: AuthRequest, res, next) => {
  try {
    await overtimeService.delete(parsePositiveInt(req.params.id, 'id'), req.user!.id);
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// 提交审批
router.post('/submit', requirePermission('overtime:submit:self'), async (req: AuthRequest, res, next) => {
  try {
    const ids = [...new Set(parseArray(req.body.ids, 'ids', (id, index) => parsePositiveInt(id, `ids[${index}]`), { min: 1, max: 100 }))];
    await overtimeService.submit(ids, req.user!.id);
    res.json({ code: 0, message: '提交成功' });
  } catch (error) {
    next(error);
  }
});

export const overtimeRoutes = router;
