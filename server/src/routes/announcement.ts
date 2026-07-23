import { Router } from 'express';
import { AnnouncementService } from '../services/announcementService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission, getUserOrgInfo } from '../middleware/permission';
import {
  parseArray,
  parseEnum,
  parseOptionalBooleanQuery,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';

const router = Router();
const announcementService = new AnnouncementService();
const auditService = new AuditService();
const announcementTypes = ['info', 'important', 'urgent'] as const;
const targetScopes = ['all', 'department', 'group', 'user'] as const;

function parseAnnouncementPayload(body: Record<string, unknown>) {
  const targetScope = parseEnum(body.targetScope ?? 'all', 'targetScope', targetScopes);
  return {
    title: parseString(body.title, 'title', { required: true, max: 200 })!,
    content: parseString(body.content, 'content', { max: 2000, trim: false }) ?? null,
    type: parseEnum(body.type ?? 'info', 'type', announcementTypes),
    targetScope,
    targetDeptId: targetScope === 'department'
      ? parsePositiveInt(body.targetDeptId, 'targetDeptId')
      : undefined,
    targetGroupId: targetScope === 'group'
      ? parsePositiveInt(body.targetGroupId, 'targetGroupId')
      : undefined,
    targetUserIds: targetScope === 'user'
      ? parseArray(body.targetUserIds, 'targetUserIds', (id, index) => (
        parsePositiveInt(id, `targetUserIds[${index}]`)
      ), { min: 1, max: 2000 })
      : undefined,
  };
}

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
    const payload = parseAnnouncementPayload(req.body as Record<string, unknown>);
    const data = await announcementService.create({
      ...payload,
      createdById: req.user!.id,
    });
    auditService.log({
      userId: req.user!.id,
      action: 'announcement.create',
      target: 'announcement',
      targetId: data.id,
      detail: JSON.stringify({ title: payload.title, targetScope: payload.targetScope, ttStatus: data.ttStatus }),
      ip: req.ip,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 更新公告
router.put('/admin/:id', requirePermission('system:announcement:update'), async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const payload = parseAnnouncementPayload(req.body as Record<string, unknown>);
    const data = await announcementService.update(
      id,
      payload,
    );
    auditService.log({ userId: req.user!.id, action: 'announcement.update', target: 'announcement', targetId: id, detail: JSON.stringify({ title: payload.title, targetScope: payload.targetScope }), ip: req.ip });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 删除公告
router.delete('/admin/:id', requirePermission('system:announcement:delete'), async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    await announcementService.delete(id);
    auditService.log({ userId: req.user!.id, action: 'announcement.delete', target: 'announcement', targetId: id, ip: req.ip });
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// 获取公告已读统计
router.get('/admin/:id/stats', requirePermission('system:announcement:view'), async (req: AuthRequest, res, next) => {
  try {
    const data = await announcementService.getReadStats(parsePositiveInt(req.params.id, 'id'));
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
    const data = await announcementService.getForUser(req.user!.id, orgInfo.departmentId, orgInfo.groupId, {
      page,
      pageSize,
      isRead: parseOptionalBooleanQuery(req.query.isRead, 'isRead'),
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
    const count = await announcementService.getUnreadCount(req.user!.id, orgInfo.departmentId, orgInfo.groupId);
    res.json({ code: 0, data: { count } });
  } catch (error) {
    next(error);
  }
});

// 标记公告已读
router.put('/my/read/:id', async (req: AuthRequest, res, next) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    await announcementService.markAsRead(
      req.user!.id,
      parsePositiveInt(req.params.id, 'id'),
      orgInfo.departmentId,
      orgInfo.groupId,
    );
    res.json({ code: 0, message: '已标记已读' });
  } catch (error) {
    next(error);
  }
});

// 标记全部公告已读
router.put('/my/read-all', async (req: AuthRequest, res, next) => {
  try {
    const orgInfo = await getUserOrgInfo(req.user!.id);
    await announcementService.markAllAsRead(req.user!.id, orgInfo.departmentId, orgInfo.groupId);
    res.json({ code: 0, message: '已全部标记已读' });
  } catch (error) {
    next(error);
  }
});

export const announcementRoutes = router;
