import { Router } from 'express';
import { SystemService } from '../services/systemService';
import { ApprovalFlowEngine } from '../services/approvalFlowService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { AppDataSource } from '../config/database';
import { SystemSetting } from '../entities/SystemSetting';
import { AccessPolicyService } from '../services/accessPolicyService';
import { BusinessError } from '../utils/errors';
import {
  firstQueryValue,
  parseArray,
  parseBooleanQuery,
  parseEnum,
  parseNonNegativeNumber,
  parseOptionalEnum,
  parseOptionalPositiveInt,
  parsePagination,
  parsePositiveInt,
  parseString,
} from '../utils/validation';

const router = Router();
const systemService = new SystemService();
const flowEngine = new ApprovalFlowEngine();
const accessPolicy = new AccessPolicyService();
const auditService = new AuditService();
const getSettingRepo = () => AppDataSource.getRepository(SystemSetting);
const projectStatuses = ['active', 'completed', 'suspended', 'cancelled'] as const;
const flowTypes = ['timesheet', 'overtime', 'weekly_report', 'permission_request'] as const;
const stepTypes = ['group_leader', 'parent_leader', 'dept_leader', 'module_se', 'project_manager', 'custom'] as const;
const settingKeys = ['system_name', 'timesheet_unit', 'timesheet_lock_day'] as const;
type DepartmentCreatePayload = { name: string; description?: string; leaderId?: number };
type DepartmentUpdatePayload = { name?: string; description?: string; leaderId?: number };
type GroupCreatePayload = { name: string; description?: string; departmentId?: number; parentId?: number; leaderId?: number };
type GroupUpdatePayload = { name?: string; description?: string; departmentId?: number; parentId?: number; leaderId?: number };
type UserCreatePayload = { username: string; password: string; realName: string; email?: string; phone?: string; departmentId?: number; groupId?: number; roleIds?: number[] };
type UserUpdatePayload = { username?: string; password?: string; realName?: string; email?: string; phone?: string; status?: number; departmentId?: number; groupId?: number; roleIds?: number[] };
type ProjectCreatePayload = { name: string; code: string; description?: string; managerIds?: number[] };
type ProjectUpdatePayload = { name?: string; code?: string; description?: string; status?: typeof projectStatuses[number]; managerIds?: number[] };
type ApprovalFlowCreatePayload = { name: string; type: string; description?: string; isDefault?: boolean; enabled?: boolean; steps: any[] };
type ApprovalFlowUpdatePayload = { name?: string; type?: string; description?: string; isDefault?: boolean; enabled?: boolean; steps?: any[] };

async function mapProjectForViewer(project: any, viewer: AuthRequest['user']) {
  const user = viewer!;
  return {
    ...project,
    managers: (project.managers || []).map((m: any) => ({ id: m.id, realName: m.realName })),
    moduleSEs: (project.moduleSEs || []).map((se: any) => ({
      ...se,
      user: se.user ? { id: se.user.id, realName: se.user.realName } : null,
      group: se.group ? { id: se.group.id, name: se.group.name } : null,
    })),
    workloadAllocations: (project.workloadAllocations || []).map((a: any) => ({
      id: a.id,
      groupId: a.groupId,
      groupName: a.group?.name || a.groupName || '',
      allocation: Number(a.allocation),
    })),
    canUpdate: await accessPolicy.canUpdateProject(user, project.id),
    canAssignSE: await accessPolicy.canAssignProjectSE(user, project.id),
    canAssignManager: await accessPolicy.hasPermission(user, 'project:assign_manager'),
    canDelete: await accessPolicy.hasPermission(user, 'project:delete'),
  };
}

/** 检查当前用户是否是系统管理员或项目管理员（针对指定项目） */
async function isProjectManagerOrAdmin(req: AuthRequest, projectId?: number): Promise<boolean> {
  const userId = req.user?.id;
  if (!userId) return false;
  if (accessPolicy.isAdmin(req.user!)) return true;
  if (projectId) {
    return accessPolicy.canAccessProject(req.user!, projectId);
  }
  return (await accessPolicy.getVisibleProjects(req.user!)).length > 0;
}

async function hasAnyPermission(req: AuthRequest, ...permissions: string[]) {
  const user = req.user;
  if (!user) return false;
  if (accessPolicy.isAdmin(user)) return true;
  for (const permission of permissions) {
    if (await accessPolicy.hasPermission(user, permission)) return true;
  }
  return false;
}

function parseOptionalIdArray(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  return parseArray(value, field, (id, index) => parsePositiveInt(id, `${field}[${index}]`), { max: 200 });
}

function uniqueIds(ids: number[]) {
  return Array.from(new Set(ids));
}

function parseDepartmentPayload(body: Record<string, unknown>, partial: true): DepartmentUpdatePayload;
function parseDepartmentPayload(body: Record<string, unknown>, partial?: false): DepartmentCreatePayload;
function parseDepartmentPayload(body: Record<string, unknown>, partial = false): DepartmentCreatePayload | DepartmentUpdatePayload {
  const parsed = {
    name: partial && body.name === undefined ? undefined : parseString(body.name, 'name', { required: !partial, max: 100 }),
    description: parseString(body.description, 'description', { max: 255 }),
    leaderId: parseOptionalPositiveInt(body.leaderId, 'leaderId'),
  };
  if (!partial) return { ...parsed, name: parsed.name! } satisfies DepartmentCreatePayload;
  return parsed;
}

function parseGroupPayload(body: Record<string, unknown>, partial: true): GroupUpdatePayload;
function parseGroupPayload(body: Record<string, unknown>, partial?: false): GroupCreatePayload;
function parseGroupPayload(body: Record<string, unknown>, partial = false): GroupCreatePayload | GroupUpdatePayload {
  const parsed = {
    name: partial && body.name === undefined ? undefined : parseString(body.name, 'name', { required: !partial, max: 100 }),
    description: parseString(body.description, 'description', { max: 255 }),
    departmentId: parseOptionalPositiveInt(body.departmentId, 'departmentId'),
    parentId: parseOptionalPositiveInt(body.parentId, 'parentId'),
    leaderId: parseOptionalPositiveInt(body.leaderId, 'leaderId'),
  };
  if (!partial) return { ...parsed, name: parsed.name! } satisfies GroupCreatePayload;
  return parsed;
}

function parseUserPayload(body: Record<string, unknown>, partial: true): UserUpdatePayload;
function parseUserPayload(body: Record<string, unknown>, partial?: false): UserCreatePayload;
function parseUserPayload(body: Record<string, unknown>, partial = false): UserCreatePayload | UserUpdatePayload {
  const statusValue = body.status === undefined ? undefined : Number(parseEnum(String(body.status), 'status', ['0', '1']));
  const parsed = {
    username: partial && body.username === undefined ? undefined : parseString(body.username, 'username', { required: !partial, max: 50 }),
    password: partial || body.password === undefined ? undefined : parseString(body.password, 'password', { required: true, max: 128 }),
    realName: partial && body.realName === undefined ? undefined : parseString(body.realName, 'realName', { required: !partial, max: 50 }),
    email: parseString(body.email, 'email', { max: 100 }),
    phone: parseString(body.phone, 'phone', { max: 20 }),
    status: statusValue,
    departmentId: parseOptionalPositiveInt(body.departmentId, 'departmentId'),
    groupId: parseOptionalPositiveInt(body.groupId, 'groupId'),
    roleIds: parseOptionalIdArray(body.roleIds, 'roleIds'),
  };
  if (!partial) {
    return {
      ...parsed,
      username: parsed.username!,
      password: parsed.password!,
      realName: parsed.realName!,
    } satisfies UserCreatePayload;
  }
  return parsed;
}

function parseProjectPayload(body: Record<string, unknown>, partial: true): ProjectUpdatePayload;
function parseProjectPayload(body: Record<string, unknown>, partial?: false): ProjectCreatePayload;
function parseProjectPayload(body: Record<string, unknown>, partial = false): ProjectCreatePayload | ProjectUpdatePayload {
  const managerIds = parseOptionalIdArray(body.managerIds, 'managerIds') ?? [];
  const pmId = parseOptionalPositiveInt(body.pmId, 'pmId');
  const spmId = parseOptionalPositiveInt(body.spmId, 'spmId');
  const normalizedManagerIds = managerIds.length || pmId || spmId
    ? uniqueIds([...managerIds, ...(pmId ? [pmId] : []), ...(spmId ? [spmId] : [])])
    : undefined;

  const parsed = {
    name: partial && body.name === undefined ? undefined : parseString(body.name, 'name', { required: !partial, max: 100 }),
    code: partial && body.code === undefined ? undefined : parseString(body.code, 'code', { required: !partial, max: 50 }),
    description: parseString(body.description, 'description', { max: 255 }),
    status: parseOptionalEnum(body.status, 'status', projectStatuses),
    managerIds: normalizedManagerIds,
  };
  if (!partial) return { ...parsed, name: parsed.name!, code: parsed.code! } satisfies ProjectCreatePayload;
  return parsed;
}

function parseApprovalFlowPayload(body: Record<string, unknown>, partial: true): ApprovalFlowUpdatePayload;
function parseApprovalFlowPayload(body: Record<string, unknown>, partial?: false): ApprovalFlowCreatePayload;
function parseApprovalFlowPayload(body: Record<string, unknown>, partial = false): ApprovalFlowCreatePayload | ApprovalFlowUpdatePayload {
  const steps = body.steps === undefined
    ? undefined
    : parseArray(body.steps, 'steps', (stepValue, index) => {
      const step = stepValue as Record<string, unknown>;
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new BusinessError(`steps[${index}]格式无效`);
      const stepType = parseEnum(step.stepType, `steps[${index}].stepType`, stepTypes);
      const customApproverId = stepType === 'custom'
        ? parsePositiveInt(step.customApproverId, `steps[${index}].customApproverId`)
        : undefined;
      return {
        stepType,
        label: parseString(step.label, `steps[${index}].label`, { required: true, max: 100 }),
        parentLevel: parseOptionalPositiveInt(step.parentLevel, `steps[${index}].parentLevel`, { max: 20 }) || 1,
        customApproverId: customApproverId ?? null,
        requireAllApprovers: parseBooleanQuery(step.requireAllApprovers),
      };
    }, { min: partial ? 0 : 1, max: 20 });

  const parsed = {
    name: partial && body.name === undefined ? undefined : parseString(body.name, 'name', { required: !partial, max: 100 }),
    type: partial && body.type === undefined ? undefined : parseEnum(body.type, 'type', flowTypes),
    description: parseString(body.description, 'description', { max: 255 }),
    isDefault: body.isDefault === undefined ? undefined : parseBooleanQuery(body.isDefault),
    enabled: body.enabled === undefined ? undefined : parseBooleanQuery(body.enabled),
    steps,
  };
  if (!partial) {
    return {
      ...parsed,
      name: parsed.name!,
      type: parsed.type!,
      steps: parsed.steps!,
    } satisfies ApprovalFlowCreatePayload;
  }
  return parsed;
}

function parseProjectSEPayload(body: Record<string, unknown>) {
  return {
    userId: parsePositiveInt(body.userId, 'userId'),
    groupId: parsePositiveInt(body.groupId, 'groupId'),
  };
}

function parseProjectAllocationPayload(body: Record<string, unknown>) {
  return {
    groupId: parsePositiveInt(body.groupId, 'groupId'),
    allocation: parseNonNegativeNumber(body.allocation, 'allocation'),
  };
}

// 所有系统管理路由需要认证
router.use(authMiddleware);

// ========== 部门 ==========
router.get('/departments', async (req, res, next) => {
  try {
    const data = await systemService.getDepartments();
    res.json({ code: 0, data: data.map(d => ({
      ...d,
      leader: d.leader ? { id: d.leader.id, realName: d.leader.realName } : null,
    })) });
  } catch (error) {
    next(error);
  }
});

router.post('/departments', requirePermission('system:org:manage'), async (req, res, next) => {
  try {
    const data = await systemService.createDepartment(parseDepartmentPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/departments/:id', requirePermission('system:org:manage'), async (req, res, next) => {
  try {
    const data = await systemService.updateDepartment(parsePositiveInt(req.params.id, 'id'), parseDepartmentPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

router.delete('/departments/:id', requirePermission('system:org:manage'), async (req, res, next) => {
  try {
    await systemService.deleteDepartment(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 分组（树形） ==========
router.get('/groups/tree', async (req, res, next) => {
  try {
    const data = await systemService.getGroupTree(parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId'));
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/groups', async (req: AuthRequest, res, next) => {
  try {
    const data = await systemService.getGroups(
      parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId'),
      parseOptionalPositiveInt(firstQueryValue(req.query.parentId), 'parentId'),
    );
    res.json({ code: 0, data: data.map(g => ({
      ...g,
      leader: g.leader ? { id: g.leader.id, realName: g.leader.realName } : null,
      parent: g.parent ? { id: g.parent.id, name: g.parent.name } : null,
    })) });
  } catch (error) {
    next(error);
  }
});

router.post('/groups', requirePermission('system:org:manage'), async (req, res, next) => {
  try {
    const data = await systemService.createGroup(parseGroupPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/groups/:id', requirePermission('system:org:manage'), async (req, res, next) => {
  try {
    const data = await systemService.updateGroup(parsePositiveInt(req.params.id, 'id'), parseGroupPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

router.delete('/groups/:id', requirePermission('system:org:manage'), async (req, res, next) => {
  try {
    await systemService.deleteGroup(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 用户 ==========
router.get('/users', requirePermission('system:user:manage'), async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query);
    const data = await systemService.getUsers({
      keyword: parseString(firstQueryValue(req.query.keyword), 'keyword', { max: 100 }),
      departmentId: parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId'),
      groupId: parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId'),
      page,
      pageSize,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 获取所有用户（供选择器用）- 系统管理员或项目管理员可访问
router.get('/users/all', async (req: AuthRequest, res, next) => {
  try {
    if (!await hasAnyPermission(
      req,
      'system:user:manage',
      'system:org:manage',
      'project:create',
      'project:update',
      'project:assign_manager',
      'project:assign_se',
      'system:announcement:create',
      'system:announcement:update',
      'permission_grant:manage',
    )) {
      return res.status(403).json({ code: 403, message: 'Forbidden' });
    }
    const data = await systemService.getAllUsers();
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.post('/users', requirePermission('system:user:manage'), async (req, res, next) => {
  try {
    const data = await systemService.createUser(parseUserPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id', requirePermission('system:user:manage'), async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = await systemService.updateUser(id, parseUserPayload(req.body as Record<string, unknown>, true));
    const actor = (req as AuthRequest).user!;
    const statusChanged = (req.body as Record<string, unknown>).status !== undefined;
    auditService.log({
      userId: actor.id,
      action: statusChanged ? `user.${(req.body as Record<string, unknown>).status === 0 ? 'disable' : 'enable'}` : 'user.update',
      target: 'user',
      targetId: id,
      ip: req.ip,
    });
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', requirePermission('system:user:manage'), async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    await systemService.deleteUser(id);
    const actor = (req as AuthRequest).user!;
    auditService.log({ userId: actor.id, action: 'user.delete', target: 'user', targetId: id, ip: req.ip });
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/reset-password', requirePermission('system:user:manage'), async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const body = req.body as Record<string, unknown>;
    // 未指定密码时生成随机密码（不再默认弱密码 123456）
    let password = parseString(body.password, 'password', { max: 128 });
    let generated = false;
    if (!password) {
      password = Math.random().toString(36).slice(2, 10) + Math.floor(Math.random() * 90 + 10);
      generated = true;
    }
    await systemService.resetPassword(id, password);
    const actor = (req as AuthRequest).user!;
    auditService.log({ userId: actor.id, action: 'user.reset_password', target: 'user', targetId: id, ip: req.ip });
    res.json({ code: 0, message: '密码重置成功', data: generated ? { password } : undefined });
  } catch (error) {
    next(error);
  }
});

// ========== 角色 ==========
router.get('/roles', requirePermission('system:user:manage', 'system:role:manage'), async (req, res, next) => {
  try {
    const data = await systemService.getRoles();
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.put('/roles/:id/permissions', requirePermission('system:role:manage'), async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const permissionIds = parseArray(req.body.permissionIds, 'permissionIds', (pid, index) => parsePositiveInt(pid, `permissionIds[${index}]`), { max: 500 });
    const data = await systemService.updateRolePermissions(id, permissionIds);
    const actor = (req as AuthRequest).user!;
    auditService.log({
      userId: actor.id,
      action: 'role.update_permissions',
      target: 'role',
      targetId: id,
      detail: JSON.stringify({ permissionIds }),
      ip: req.ip,
    });
    res.json({ code: 0, data, message: '权限更新成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 权限 ==========
router.get('/permissions', requirePermission('system:role:manage', 'system:permission:manage'), async (req, res, next) => {
  try {
    const data = await systemService.getPermissions();
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.post('/permissions/init', requirePermission('system:permission:manage'), async (req, res, next) => {
  try {
    const data = await systemService.initPermissions();
    res.json({ code: 0, data, message: '权限初始化成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 项目 ==========
router.get('/projects', async (req, res, next) => {
  try {
    const viewer = (req as AuthRequest).user!;
    const visibleProjects = await accessPolicy.getVisibleProjects(viewer);
    if (!visibleProjects.length && !accessPolicy.isAdmin(viewer)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = visibleProjects;
    res.json({ code: 0, data: await Promise.all(data.map(p => mapProjectForViewer(p, viewer))) });
  } catch (error) {
    next(error);
  }
});

// 获取进行中的项目列表（所有登录用户可访问，用于工时选择等）
router.get('/projects/active', async (req, res, next) => {
  try {
    const data = await systemService.getActiveProjects();
    res.json({ code: 0, data: data.map(p => ({ id: p.id, name: p.name, code: p.code })) });
  } catch (error) {
    next(error);
  }
});

// 管理员获取自己负责的项目
router.get('/projects/my', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ code: 401, message: '未登录' });
    const data = await accessPolicy.getVisibleProjects(req.user!);
    res.json({ code: 0, data: await Promise.all(data.map(p => mapProjectForViewer(p, req.user!))) });
  } catch (error) {
    next(error);
  }
});

// 检查当前用户是否可看项目管理
router.get('/projects/can-view', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ code: 401, message: '未登录' });
    const isAdmin = accessPolicy.isAdmin(req.user!);
    const visibleProjects = await accessPolicy.getVisibleProjects(req.user!);
    const isManager = visibleProjects.length > 0 && !isAdmin;
    res.json({ code: 0, data: { canView: isAdmin || visibleProjects.length > 0, isAdmin, isManager } });
  } catch (error) {
    next(error);
  }
});

// 创建项目 - 仅系统管理员
router.post('/projects', requirePermission('project:create'), async (req, res, next) => {
  try {
    const data = await systemService.createProject(parseProjectPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

// 更新项目 - 系统管理员或项目管理员
router.put('/projects/:id', async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(req.params.id, 'id');
    if (!await accessPolicy.canUpdateProject(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const payload = parseProjectPayload(req.body as Record<string, unknown>, true);
    if (payload.managerIds !== undefined && !await hasAnyPermission(req, 'project:assign_manager')) {
      return res.status(403).json({ code: 403, message: 'Forbidden' });
    }
    const data = await systemService.updateProject(projectId, payload);
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

// 删除项目 - 仅系统管理员
router.delete('/projects/:id', requirePermission('project:delete'), async (req, res, next) => {
  try {
    await systemService.deleteProject(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 项目SE ==========
router.get('/projects/:projectId/ses', async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(req.params.projectId, 'projectId');
    if (!await accessPolicy.canAccessProject(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.getProjectSEs(projectId);
    res.json({ code: 0, data: data.map(se => ({
      ...se,
      user: se.user ? { id: se.user.id, realName: se.user.realName } : null,
      group: se.group ? { id: se.group.id, name: se.group.name } : null,
    })) });
  } catch (error) {
    next(error);
  }
});

router.post('/projects/:projectId/ses', async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(req.params.projectId, 'projectId');
    if (!await accessPolicy.canAssignProjectSE(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.addProjectSE({
      projectId,
      ...parseProjectSEPayload(req.body as Record<string, unknown>),
    });
    res.json({ code: 0, data, message: '添加成功' });
  } catch (error) {
    next(error);
  }
});

router.delete('/projects/ses/:id', async (req: AuthRequest, res, next) => {
  try {
    // 先检查是否有权操作该SE对应的项目
    
    const id = parsePositiveInt(req.params.id, 'id');
    const se = await systemService.getProjectSEById(id);
    if (!se) return res.status(404).json({ code: 404, message: 'SE记录不存在' });
    if (!await accessPolicy.canAssignProjectSE(req.user!, se.projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    await systemService.removeProjectSE(id);
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 项目工时配额（按组配置，单位人/天） ==========
router.get('/projects/:projectId/allocations', async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(req.params.projectId, 'projectId');
    if (!await accessPolicy.canAccessProject(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.getProjectAllocations(projectId);
    res.json({ code: 0, data: data.map(a => ({
      id: a.id,
      groupId: a.groupId,
      groupName: a.group?.name || a.groupName || '',
      allocation: Number(a.allocation),
    })) });
  } catch (error) {
    next(error);
  }
});

router.post('/projects/:projectId/allocations', async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(req.params.projectId, 'projectId');
    // 复用 project:update 权限（与编辑项目一致）
    if (!await accessPolicy.canUpdateProject(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.addProjectAllocation({
      projectId,
      ...parseProjectAllocationPayload(req.body as Record<string, unknown>),
    });
    res.json({ code: 0, data, message: '保存成功' });
  } catch (error) {
    next(error);
  }
});

router.delete('/projects/allocations/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const allocation = await systemService.getProjectAllocationById(id);
    if (!allocation) return res.status(404).json({ code: 404, message: '配额记录不存在' });
    if (!await accessPolicy.canUpdateProject(req.user!, allocation.projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    await systemService.removeProjectAllocation(id);
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

// ========== 审批流程 ==========
router.get('/approval-flows', requirePermission('system:approval_flow:manage'), async (req, res, next) => {
  try {
    const type = parseOptionalEnum(firstQueryValue(req.query.type), 'type', flowTypes);
    const data = await flowEngine.getFlows(type);
    res.json({ code: 0, data: data.map(f => ({
      ...f,
      steps: (f.steps || []).sort((a: any, b: any) => a.stepOrder - b.stepOrder),
    })) });
  } catch (error) {
    next(error);
  }
});

router.get('/approval-flows/:id', requirePermission('system:approval_flow:manage'), async (req, res, next) => {
  try {
    const data = await flowEngine.getFlow(parsePositiveInt(req.params.id, 'id'));
    if (!data) return res.status(404).json({ code: 404, message: '审批流程不存在' });
    res.json({ code: 0, data: { ...data, steps: (data.steps || []).sort((a: any, b: any) => a.stepOrder - b.stepOrder) } });
  } catch (error) {
    next(error);
  }
});

router.post('/approval-flows', requirePermission('system:approval_flow:manage'), async (req, res, next) => {
  try {
    const data = await flowEngine.createFlow(parseApprovalFlowPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error) {
    next(error);
  }
});

router.put('/approval-flows/:id', requirePermission('system:approval_flow:manage'), async (req, res, next) => {
  try {
    const data = await flowEngine.updateFlow(parsePositiveInt(req.params.id, 'id'), parseApprovalFlowPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});

router.delete('/approval-flows/:id', requirePermission('system:approval_flow:manage'), async (req, res, next) => {
  try {
    await flowEngine.deleteFlow(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

export const systemRoutes = router;

// ========== 系统设置 ==========
// 所有登录用户可读设置
router.get('/settings', async (_req, res, next) => {
  try {
    const { CacheKeys, CacheTtl, cacheGetOrLoad } = await import('../config/cache');
    const cacheKey = CacheKeys.allSettings();
    const data = await cacheGetOrLoad(cacheKey, CacheTtl.setting, async () => {
      const settingRepo = getSettingRepo();
      const list = await settingRepo.find({ order: { id: 'ASC' } });
      const settings: Record<string, string> = {};
      list.forEach(s => { settings[s.key] = s.value; });
      return { list, settings };
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.put('/settings/:key', requirePermission('system:settings:manage'), async (req: AuthRequest, res, next) => {
  try {
    const settingRepo = getSettingRepo();
    const key = parseEnum(req.params.key, 'key', settingKeys);
    const rawValue = (req.body as Record<string, unknown>).value;
    let value = parseString(rawValue, 'value', { max: 200 }) ?? '';
    if (key === 'timesheet_unit') {
      // 工时填报单位（天步长）：兼容老值 days(=0.5) / hours(=0.5)
      if (value === 'days' || value === 'hours') value = '0.5';
      value = parseEnum(value, 'value', ['0.1', '0.2', '0.25', '0.5']);
    }
    if (key === 'timesheet_lock_day' && value) {
      value = String(parsePositiveInt(value, 'value', { max: 28 }));
    }
    let setting = await settingRepo.findOne({ where: { key } });
    if (setting) {
      setting.value = value;
      await settingRepo.save(setting);
    } else {
      setting = settingRepo.create({ key, value });
      await settingRepo.save(setting);
    }
    const { invalidateSetting } = await import('../config/cache');
    await invalidateSetting(key);
    auditService.log({
      userId: req.user!.id,
      action: 'settings.update',
      target: 'system_setting',
      targetId: setting.id,
      detail: JSON.stringify({ key, value }),
      ip: req.ip,
    });
    res.json({ code: 0, data: setting, message: '更新成功' });
  } catch (error) {
    next(error);
  }
});
