import { Router } from 'express';
import { TimesheetService } from '../services/timesheetService';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import {
  firstQueryValue,
  parseArray,
  parseBooleanQuery,
  parseDateString,
  parseDays,
  parseOptionalDateString,
  parseOptionalEnum,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';
import { canAccessUserData } from '../utils/accessControl';
import { BusinessError } from '../utils/errors';

const router = Router();
const timesheetService = new TimesheetService();
const timesheetStatuses = ['draft', 'submitted', 'approved', 'rejected', 'deprecated'] as const;

function parseTimesheetItem(item: unknown, index: number) {
  const row = item as Record<string, unknown>;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BusinessError(`items[${index}]格式无效`);
  return {
    projectId: parsePositiveInt(row.projectId, `items[${index}].projectId`),
    date: parseDateString(row.date, `items[${index}].date`),
    days: parseDays(row.days, `items[${index}].days`),
    description: parseString(row.description, `items[${index}].description`, { max: 1000 }),
  };
}

function parseTimesheetRow(rowValue: unknown, index: number) {
  const row = rowValue as Record<string, unknown>;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BusinessError(`rows[${index}]格式无效`);
  return {
    projectId: parsePositiveInt(row.projectId, `rows[${index}].projectId`),
    // 提交审批/修改时工作内容必填（草稿不经过此解析，允许空）。required 由 parseString 内部 trim 校验。
    description: parseString(row.description, `rows[${index}].description`, { required: true, max: 1000 })!,
    weekStart: parseDateString(row.weekStart, `rows[${index}].weekStart`),
    entries: parseArray(row.entries, `rows[${index}].entries`, (entryValue, entryIndex) => {
      const entry = entryValue as Record<string, unknown>;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new BusinessError(`rows[${index}].entries[${entryIndex}]格式无效`);
      return {
        date: parseDateString(entry.date, `rows[${index}].entries[${entryIndex}].date`),
        days: parseDays(entry.days, `rows[${index}].entries[${entryIndex}].days`),
      };
    }, { min: 1, max: 7 }),
  };
}

router.use(authMiddleware);

// 查看自己的工时 — 所有登录用户
router.get('/my', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query, 50);
    const data = await timesheetService.getByUser(req.user!.id, {
      startDate: parseOptionalDateString(firstQueryValue(req.query.startDate), 'startDate'),
      endDate: parseOptionalDateString(firstQueryValue(req.query.endDate), 'endDate'),
      status: parseOptionalEnum(firstQueryValue(req.query.status), 'status', timesheetStatuses),
      page,
      pageSize,
      includeAll: parseBooleanQuery(firstQueryValue(req.query.includeAll)),
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 查看周汇总 — 所有登录用户（查看自己的）或管理员/经理查看别人的
router.get('/weekly-summary', requirePermission('timesheet:read'), async (req: AuthRequest, res, next) => {
  try {
    const weekStart = parseDateString(firstQueryValue(req.query.weekStart), 'weekStart');
    const weekEnd = parseDateString(firstQueryValue(req.query.weekEnd), 'weekEnd');
    const targetUserId = req.query.userId ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId') : req.user!.id;
    if (!await canAccessUserData(req.user!, targetUserId, {
      departmentPermissions: ['timesheet:view:department'],
      groupPermissions: ['timesheet:view:group'],
    })) {
      return res.status(403).json({ code: 403, message: '只能查看自己或负责部门内成员的工时汇总' });
    }
    const data = await timesheetService.getWeeklySummary(targetUserId, weekStart, weekEnd);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 创建工时 — 需要 timesheet:create 权限
router.post('/', requirePermission('timesheet:create'), async (req: AuthRequest, res, next) => {
  try {
    const row = parseTimesheetItem(req.body, 0);
    const data = await timesheetService.create({ ...row, userId: req.user!.id });
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

// 批量创建工时
router.post('/batch', requirePermission('timesheet:create'), async (req: AuthRequest, res, next) => {
  try {
    const { items } = req.body;
    const parsedItems = parseArray(items, 'items', parseTimesheetItem, { min: 1, max: 200 });
    const data = await timesheetService.batchCreate(req.user!.id, parsedItems);
    res.json({ code: 0, data, message: '批量创建成功' });
  } catch (error) {
    next(error);
  }
});

// 更新工时 — service 层校验所有权和状态
router.put('/:id', requirePermission('timesheet:update'), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const data = await timesheetService.update(parsePositiveInt(req.params.id, 'id'), req.user!.id, {
      projectId: body.projectId === undefined ? undefined : parsePositiveInt(body.projectId, 'projectId'),
      days: body.days === undefined ? undefined : parseDays(body.days),
      description: parseString(body.description, 'description', { max: 1000 }),
    });
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

// 删除工时
router.delete('/:id', requirePermission('timesheet:delete'), async (req: AuthRequest, res, next) => {
  try {
    await timesheetService.delete(parsePositiveInt(req.params.id, 'id'), req.user!.id);
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// 查看某条工时的完整修改链（v1→v2→v3…，含已 deprecated 的历史版本）
router.get('/chain/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    // 鉴权：先取种子记录，校验查看者对其有访问权
    const seed = await AppDataSource.getRepository(Timesheet).findOne({ where: { id } });
    if (!seed) throw new BusinessError('记录不存在');
    const owner = seed.userId;
    if (!await canAccessUserData(req.user!, owner, {
      departmentPermissions: ['timesheet:view:department'],
      groupPermissions: ['timesheet:view:group'],
    })) {
      return res.status(403).json({ code: 403, message: '无权查看该工时的修改链' });
    }
    const data = await timesheetService.getModificationChain(id);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 提交审批
router.post('/submit', requirePermission('timesheet:create'), async (req: AuthRequest, res, next) => {
  try {
    const ids = parseArray(req.body.ids, 'ids', (id, index) => parsePositiveInt(id, `ids[${index}]`), { min: 1, max: 200 });
    await timesheetService.submit(ids, req.user!.id);
    res.json({ code: 0, message: '提交成功' });
  } catch (error) {
    next(error);
  }
});

// 修改已提交/已审批的工时（删除旧记录，创建新草稿）
router.post('/modify', requirePermission('timesheet:update'), async (req: AuthRequest, res, next) => {
  try {
    const rows = parseArray(req.body.rows, 'rows', parseTimesheetRow, { min: 1, max: 50 });
    await timesheetService.modifySubmitted(req.user!.id, rows);
    res.json({ code: 0, message: '修改成功' });
  } catch (error) {
    next(error);
  }
});

// 按行提交审批（每周表格，每行一个审批单）
router.post('/submit-rows', requirePermission('timesheet:create'), async (req: AuthRequest, res, next) => {
  try {
    const rows = parseArray(req.body.rows, 'rows', parseTimesheetRow, { min: 1, max: 50 });
    await timesheetService.submitByRows(req.user!.id, rows);
    res.json({ code: 0, message: '提交成功' });
  } catch (error) {
    next(error);
  }
});

export const timesheetRoutes = router;

