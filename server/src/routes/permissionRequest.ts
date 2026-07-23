import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { PermissionScopeType } from '../entities/UserPermissionGrant';
import { PermissionGovernanceService } from '../services/permissionGovernanceService';
import { AuditService } from '../services/auditService';
import {
  firstQueryValue,
  parseEnum,
  parseOptionalDateString,
  parseOptionalEnum,
  parseOptionalPositiveInt,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';

const router = Router();
const service = new PermissionGovernanceService();
const auditService = new AuditService();
const scopeTypes = ['self', 'group', 'department', 'project', 'global'] as const;
const requestStatuses = ['draft', 'submitted', 'approved', 'rejected', 'withdrawn'] as const;
const grantStatuses = ['active', 'revoked', 'expired'] as const;

router.use(authMiddleware);

router.get('/grantable-permissions', requirePermission('permission_request:access'), async (_req, res, next) => {
  try {
    res.json({ code: 0, data: await service.getGrantableDefinitions() });
  } catch (error) {
    next(error);
  }
});

router.get('/my', requirePermission('permission_request:view:self'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await service.getRequests({
      applicantId: req.user!.id,
      status: parseOptionalEnum(firstQueryValue(req.query.status), 'status', requestStatuses),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/all', requirePermission('permission_request:view:all'), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await service.getRequests({
      status: parseOptionalEnum(firstQueryValue(req.query.status), 'status', requestStatuses),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('permission_request:create'), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const expiresAtString = parseOptionalDateString(body.expiresAt, 'expiresAt');
    const data = await service.createAndSubmit(req.user!.id, {
      permissionCode: parseString(body.permissionCode, 'permissionCode', { required: true, max: 100 })!,
      scopeType: parseEnum(body.scopeType, 'scopeType', scopeTypes) as PermissionScopeType,
      scopeId: parseOptionalPositiveInt(body.scopeId, 'scopeId'),
      reason: parseString(body.reason, 'reason', { required: true, max: 1000 })!,
      expiresAt: expiresAtString ? new Date(`${expiresAtString}T23:59:59`) : null,
    });
    res.json({ code: 0, data, message: '权限申请已提交' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/withdraw', requirePermission('permission_request:create'), async (req: AuthRequest, res, next) => {
  try {
    const data = await service.withdraw(parsePositiveInt(req.params.id, 'id'), req.user!.id);
    res.json({ code: 0, data, message: '权限申请已撤回' });
  } catch (error) {
    next(error);
  }
});

router.get('/grants', requirePermission('permission_grant:manage'), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await service.getGrants({
      userId: parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId'),
      status: parseOptionalEnum(firstQueryValue(req.query.status), 'status', grantStatuses),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/users', requirePermission('permission_grant:manage'), async (_req, res, next) => {
  try {
    res.json({ code: 0, data: await service.getUserOptions() });
  } catch (error) {
    next(error);
  }
});

router.post('/grants/:id/revoke', requirePermission('permission_grant:manage'), async (req: AuthRequest, res, next) => {
  try {
    const grantId = parsePositiveInt(req.params.id, 'id');
    const reason = parseString((req.body as Record<string, unknown>).reason, 'reason', { required: true, max: 255 });
    const data = await service.revokeGrant(grantId, req.user!.id, reason);
    auditService.log({
      userId: req.user!.id,
      action: 'permission_grant.revoke',
      target: 'user_permission_grant',
      targetId: grantId,
      detail: JSON.stringify({ reason }),
      ip: req.ip,
    });
    res.json({ code: 0, data, message: '授权已撤销' });
  } catch (error) {
    next(error);
  }
});

export const permissionRequestRoutes = router;
