import { Router } from 'express';
import { ApprovalService } from '../services/approvalService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { BusinessError } from '../utils/errors';
import {
  firstQueryValue,
  parseArray,
  parseBooleanQuery,
  parseEnum,
  parseOptionalEnum,
  parseOptionalPositiveInt,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';

const router = Router();
const approvalService = new ApprovalService();
const auditService = new AuditService();
const userRepo = AppDataSource.getRepository(User);
const targetTypes = ['timesheet', 'overtime', 'weekly_report', 'permission_request'] as const;
const approvalStatuses = ['draft', 'submitted', 'approved', 'rejected', 'deprecated', 'withdrawn'] as const;
const approvalActions = ['approve', 'reject'] as const;

router.use(authMiddleware);

// 获取用户列表（用于抄送选择）— 所有登录用户可访问
router.get('/users', async (req: AuthRequest, res, next) => {

  try {
    const users = await userRepo.find({
      relations: ['department'],
      select: ['id', 'realName', 'department'],
    });
    res.json({ code: 0, data: users.map((u: any) => ({
      id: u.id,
      realName: u.realName,
      department: u.department?.name || null,
    })) });
  } catch (error) {
    next(error);
  }
});

// 获取我的申请列表 — 所有登录用户可查看

router.get('/my-submissions', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query, 20);
    const data = await approvalService.getMySubmissions(req.user!.id, {
      targetType: parseOptionalEnum(firstQueryValue(req.query.targetType), 'targetType', targetTypes),
      status: parseOptionalEnum(firstQueryValue(req.query.status), 'status', approvalStatuses),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 获取待审批列表 — 所有登录用户（service层基于审批流程引擎判断可见性）
router.get('/pending', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query, 20);
    const data = await approvalService.getPendingList(req.user!.id, {
      targetType: parseOptionalEnum(firstQueryValue(req.query.targetType), 'targetType', targetTypes),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 执行审批 — service层校验是否为当前步骤审批人
router.post('/approve', async (req: AuthRequest, res, next) => {
  try {
    const items = parseArray(req.body.items, 'items', (itemValue, index) => {
      const item = itemValue as Record<string, unknown>;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BusinessError(`items[${index}]格式无效`);
      return {
        targetType: parseEnum(item.targetType, `items[${index}].targetType`, targetTypes),
        targetId: parsePositiveInt(item.targetId, `items[${index}].targetId`),
        action: parseEnum(item.action, `items[${index}].action`, approvalActions),
        comment: parseString(item.comment, `items[${index}].comment`, { max: 1000 }),
      };
    }, { min: 1, max: 100 });
    const data = await approvalService.approve(req.user!.id, req.user!.realName, items);
    // 审计：记录每条审批决策
    for (const item of items) {
      auditService.log({
        userId: req.user!.id,
        action: `approval.${item.action}`,
        target: item.targetType,
        targetId: item.targetId,
        detail: JSON.stringify({ comment: item.comment }),
        ip: req.ip,
      });
    }
    res.json({ code: 0, data, message: '审批完成' });
  } catch (error) {
    next(error);
  }
});

// 审批历史 — 所有登录用户可查看
router.get('/history', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query, 20);
    const data = await approvalService.getApprovalHistory({
      targetType: parseOptionalEnum(firstQueryValue(req.query.targetType), 'targetType', targetTypes),
      targetId: parseOptionalPositiveInt(firstQueryValue(req.query.targetId), 'targetId'),
      page,
      pageSize,
      viewerId: req.user!.id,
      mine: parseBooleanQuery(firstQueryValue(req.query.mine)),
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 审批详情 — 所有登录用户可查看
router.get('/detail/:targetType/:targetId', async (req: AuthRequest, res, next) => {
  try {
    const data = await approvalService.getApprovalDetail(
      parseEnum(req.params.targetType, 'targetType', targetTypes),
      parsePositiveInt(req.params.targetId, 'targetId'),
      req.user!.id,
    );
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 撤回申请 — 仅提交人
router.post('/withdraw', async (req: AuthRequest, res, next) => {
  try {
    const targetType = parseEnum(req.body.targetType, 'targetType', targetTypes);
    const targetId = parsePositiveInt(req.body.targetId, 'targetId');
    const data = await approvalService.withdraw(req.user!.id, targetType, targetId);
    res.json({ code: 0, data, message: '已撤回' });
  } catch (error) {
    next(error);
  }
});

// 抄送传阅 — 仅提交人
router.post('/cc', async (req: AuthRequest, res, next) => {
  try {
    const targetType = parseEnum(req.body.targetType, 'targetType', targetTypes);
    const targetId = parsePositiveInt(req.body.targetId, 'targetId');
    const recipientIds = parseArray(req.body.recipientIds, 'recipientIds', (id, index) => parsePositiveInt(id, `recipientIds[${index}]`), { min: 1, max: 100 });
    const data = await approvalService.cc(req.user!.id, req.user!.realName, targetType, targetId, recipientIds);
    res.json({ code: 0, data, message: '已抄送' });
  } catch (error) {
    next(error);
  }
});

// 我收到的抄送 — 所有登录用户
router.get('/my-cc', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query, 20);
    const data = await approvalService.getMyCcList(req.user!.id, {
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

export const approvalRoutes = router;

