import { Router } from 'express';
import { SystemService } from '../services/systemService';
import { ApprovalFlowEngine } from '../services/approvalFlowService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { AppDataSource } from '../config/database';
import { SystemSetting } from '../entities/SystemSetting';
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
const systemService = new SystemService();
const flowEngine = new ApprovalFlowEngine();
const getSettingRepo = () => AppDataSource.getRepository(SystemSetting);
const projectStatuses = ['active', 'completed', 'suspended', 'cancelled'] as const;
const flowTypes = ['timesheet', 'overtime', 'weekly_report'] as const;
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

/** 检查当前用户是否是系统管理员或项目管理员（针对指定项目） */
async function isProjectManagerOrAdmin(req: AuthRequest, projectId?: number): Promise<boolean> {
  const userId = req.user?.id;
  if (!userId) return false;
  if (await systemService.isUserAdmin(userId)) return true;
  if (projectId) {
    return systemService.isUserManagerOfProject(userId, projectId);
  }
  return systemService.isUserProjectManager(userId);
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
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`steps[${index}]格式无效`);
      const stepType = parseEnum(step.stepType, `steps[${index}].stepType`, stepTypes);
      const customApproverId = stepType === 'custom'
        ? parsePositiveInt(step.customApproverId, `steps[${index}].customApproverId`)
        : undefined;
      return {
        stepType,
        label: parseString(step.label, `steps[${index}].label`, { required: true, max: 100 }),
        parentLevel: parseOptionalPositiveInt(step.parentLevel, `steps[${index}].parentLevel`, { max: 20 }) || 1,
        customApproverId: customApproverId ?? null,
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

// 所有系统管理路由需要认证
router.use(authMiddleware);

// ========== 部门 ==========
router.get('/departments', async (req, res) => {
  try {
    const data = await systemService.getDepartments();
    res.json({ code: 0, data: data.map(d => ({
      ...d,
      leader: d.leader ? { id: d.leader.id, realName: d.leader.realName } : null,
    })) });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.post('/departments', requirePermission('system:create'), async (req, res) => {
  try {
    const data = await systemService.createDepartment(parseDepartmentPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.put('/departments/:id', requirePermission('system:update'), async (req, res) => {
  try {
    const data = await systemService.updateDepartment(parsePositiveInt(req.params.id, 'id'), parseDepartmentPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.delete('/departments/:id', requirePermission('system:delete'), async (req, res) => {
  try {
    await systemService.deleteDepartment(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 分组（树形） ==========
router.get('/groups/tree', async (req, res) => {
  try {
    const data = await systemService.getGroupTree(parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId'));
    res.json({ code: 0, data });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.get('/groups', async (req: AuthRequest, res) => {
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
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.post('/groups', requirePermission('system:create'), async (req, res) => {
  try {
    const data = await systemService.createGroup(parseGroupPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.put('/groups/:id', requirePermission('system:update'), async (req, res) => {
  try {
    const data = await systemService.updateGroup(parsePositiveInt(req.params.id, 'id'), parseGroupPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.delete('/groups/:id', requirePermission('system:delete'), async (req, res) => {
  try {
    await systemService.deleteGroup(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 用户 ==========
router.get('/users', requirePermission('system:read'), async (req: AuthRequest, res) => {
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
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 获取所有用户（供选择器用）- 系统管理员或项目管理员可访问
router.get('/users/all', async (req: AuthRequest, res) => {
  try {
    if (!await isProjectManagerOrAdmin(req)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.getAllUsers();
    res.json({ code: 0, data });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.post('/users', requirePermission('system:create'), async (req, res) => {
  try {
    const data = await systemService.createUser(parseUserPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.put('/users/:id', requirePermission('system:update'), async (req, res) => {
  try {
    const data = await systemService.updateUser(parsePositiveInt(req.params.id, 'id'), parseUserPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.delete('/users/:id', requirePermission('system:delete'), async (req, res) => {
  try {
    await systemService.deleteUser(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.put('/users/:id/reset-password', requirePermission('system:update'), async (req, res) => {
  try {
    const password = parseString((req.body as Record<string, unknown>).password ?? '123456', 'password', { required: true, max: 128 })!;
    await systemService.resetPassword(parsePositiveInt(req.params.id, 'id'), password);
    res.json({ code: 0, message: '密码重置成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 角色 ==========
router.get('/roles', requirePermission('system:read'), async (req, res) => {
  try {
    const data = await systemService.getRoles();
    res.json({ code: 0, data });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.put('/roles/:id/permissions', requirePermission('system:update'), async (req, res) => {
  try {
    const permissionIds = parseArray(req.body.permissionIds, 'permissionIds', (id, index) => parsePositiveInt(id, `permissionIds[${index}]`), { max: 500 });
    const data = await systemService.updateRolePermissions(parsePositiveInt(req.params.id, 'id'), permissionIds);
    res.json({ code: 0, data, message: '权限更新成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 权限 ==========
router.get('/permissions', requirePermission('system:read'), async (req, res) => {
  try {
    const data = await systemService.getPermissions();
    res.json({ code: 0, data });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.post('/permissions/init', requirePermission('system:create'), async (req, res) => {
  try {
    const data = await systemService.initPermissions();
    res.json({ code: 0, data, message: '权限初始化成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 项目 ==========
router.get('/projects', async (req, res) => {
  try {
    if (!await isProjectManagerOrAdmin(req as AuthRequest)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.getProjects();
    res.json({ code: 0, data: data.map(p => ({
      ...p,
      managers: (p.managers || []).map((m: any) => ({ id: m.id, realName: m.realName })),
      moduleSEs: (p.moduleSEs || []).map((se: any) => ({
        ...se,
        user: se.user ? { id: se.user.id, realName: se.user.realName } : null,
        group: se.group ? { id: se.group.id, name: se.group.name } : null,
      })),
    })) });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 获取进行中的项目列表（所有登录用户可访问，用于工时选择等）
router.get('/projects/active', async (req, res) => {
  try {
    const data = await systemService.getActiveProjects();
    res.json({ code: 0, data: data.map(p => ({ id: p.id, name: p.name, code: p.code })) });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 管理员获取自己负责的项目
router.get('/projects/my', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ code: 401, message: '未登录' });
    const data = await systemService.getMyManagedProjects(userId);
    res.json({ code: 0, data: data.map(p => ({
      ...p,
      managers: (p.managers || []).map((m: any) => ({ id: m.id, realName: m.realName })),
      moduleSEs: (p.moduleSEs || []).map((se: any) => ({
        ...se,
        user: se.user ? { id: se.user.id, realName: se.user.realName } : null,
        group: se.group ? { id: se.group.id, name: se.group.name } : null,
      })),
    })) });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 检查当前用户是否可看项目管理
router.get('/projects/can-view', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ code: 401, message: '未登录' });
    const isAdmin = await systemService.isUserAdmin(userId);
    const isManager = await systemService.isUserProjectManager(userId);
    res.json({ code: 0, data: { canView: isAdmin || isManager, isAdmin, isManager } });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 创建项目 - 仅系统管理员
router.post('/projects', requirePermission('system:create'), async (req, res) => {
  try {
    const data = await systemService.createProject(parseProjectPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 更新项目 - 系统管理员或项目管理员
router.put('/projects/:id', async (req: AuthRequest, res) => {
  try {
    const projectId = parsePositiveInt(req.params.id, 'id');
    if (!await isProjectManagerOrAdmin(req, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.updateProject(projectId, parseProjectPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// 删除项目 - 仅系统管理员
router.delete('/projects/:id', requirePermission('system:delete'), async (req, res) => {
  try {
    await systemService.deleteProject(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 项目SE ==========
router.get('/projects/:projectId/ses', async (req: AuthRequest, res) => {
  try {
    const projectId = parsePositiveInt(req.params.projectId, 'projectId');
    if (!await isProjectManagerOrAdmin(req, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.getProjectSEs(projectId);
    res.json({ code: 0, data: data.map(se => ({
      ...se,
      user: se.user ? { id: se.user.id, realName: se.user.realName } : null,
      group: se.group ? { id: se.group.id, name: se.group.name } : null,
    })) });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.post('/projects/:projectId/ses', async (req: AuthRequest, res) => {
  try {
    const projectId = parsePositiveInt(req.params.projectId, 'projectId');
    if (!await isProjectManagerOrAdmin(req, projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    const data = await systemService.addProjectSE({
      projectId,
      ...parseProjectSEPayload(req.body as Record<string, unknown>),
    });
    res.json({ code: 0, data, message: '添加成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.delete('/projects/ses/:id', async (req: AuthRequest, res) => {
  try {
    // 先检查是否有权操作该SE对应的项目
    const id = parsePositiveInt(req.params.id, 'id');
    const se = await systemService.getProjectSEById(id);
    if (!se) return res.status(404).json({ code: 404, message: 'SE记录不存在' });
    if (!await isProjectManagerOrAdmin(req, se.projectId)) {
      return res.status(403).json({ code: 403, message: '无此操作权限' });
    }
    await systemService.removeProjectSE(id);
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

// ========== 审批流程 ==========
router.get('/approval-flows', requirePermission('system:read'), async (req, res) => {
  try {
    const type = parseOptionalEnum(firstQueryValue(req.query.type), 'type', flowTypes);
    const data = await flowEngine.getFlows(type);
    res.json({ code: 0, data: data.map(f => ({
      ...f,
      steps: (f.steps || []).sort((a: any, b: any) => a.stepOrder - b.stepOrder),
    })) });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.get('/approval-flows/:id', requirePermission('system:read'), async (req, res) => {
  try {
    const data = await flowEngine.getFlow(parsePositiveInt(req.params.id, 'id'));
    if (!data) return res.status(404).json({ code: 404, message: '审批流程不存在' });
    res.json({ code: 0, data: { ...data, steps: (data.steps || []).sort((a: any, b: any) => a.stepOrder - b.stepOrder) } });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.post('/approval-flows', requirePermission('system:create'), async (req, res) => {
  try {
    const data = await flowEngine.createFlow(parseApprovalFlowPayload(req.body as Record<string, unknown>));
    res.json({ code: 0, data, message: '创建成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.put('/approval-flows/:id', requirePermission('system:update'), async (req, res) => {
  try {
    const data = await flowEngine.updateFlow(parsePositiveInt(req.params.id, 'id'), parseApprovalFlowPayload(req.body as Record<string, unknown>, true));
    res.json({ code: 0, data, message: '更新成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

router.delete('/approval-flows/:id', requirePermission('system:delete'), async (req, res) => {
  try {
    await flowEngine.deleteFlow(parsePositiveInt(req.params.id, 'id'));
    res.json({ code: 0, message: '删除成功' });
  } catch (error: any) { res.status(400).json({ code: 400, message: error.message }); }
});

export const systemRoutes = router;

// ========== 系统设置 ==========
// 所有登录用户可读设置
router.get('/settings', async (_req, res) => {
  try {
    const settingRepo = getSettingRepo();
    const list = await settingRepo.find({ order: { id: 'ASC' } });
    // 转成 key-value 对象方便前端使用
    const settings: Record<string, string> = {};
    list.forEach(s => { settings[s.key] = s.value; });
    res.json({ code: 0, data: { list, settings } });
  } catch (error: any) { res.status(500).json({ code: 500, message: error.message }); }
});

router.put('/settings/:key', requirePermission('system:update'), async (req: AuthRequest, res) => {
  try {
    const settingRepo = getSettingRepo();
    const key = parseEnum(req.params.key, 'key', settingKeys);
    const rawValue = (req.body as Record<string, unknown>).value;
    let value = parseString(rawValue, 'value', { max: 200 }) ?? '';
    if (key === 'timesheet_unit') value = parseEnum(value, 'value', ['days', 'hours']);
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
    res.json({ code: 0, data: setting, message: '更新成功' });
  } catch (error: any) { res.status(500).json({ code: 500, message: error.message }); }
});
