import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuditService } from '@server/services/auditService';
import { SystemService } from '@server/services/systemService';
import { AppDataSource } from '@server/config/database';
import { AccessPolicyService } from '@server/services/accessPolicyService';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/config/cache', () => ({
  CacheKeys: { allSettings: () => 'settings:all' },
  CacheTtl: { setting: 60 },
  cacheGetOrLoad: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateSetting: vi.fn(async () => undefined),
}));

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    const isEmployee = req.headers['x-test-role'] === 'employee';
    const requestedPermissions = typeof req.headers['x-test-permissions'] === 'string'
      ? req.headers['x-test-permissions'].split(',').filter(Boolean)
      : null;
    req.user = {
      id: 1,
      username: isEmployee ? 'employee' : 'admin',
      realName: isEmployee ? '员工' : '管理员',
      roles: [isEmployee ? 'employee' : 'admin'],
    };
    req.userPermissions = new Set(requestedPermissions || [
      'system:org:manage',
      'system:user:manage',
      'system:role:manage',
      'project:access',
    ]);
    next();
  },
}));

const { systemRoutes } = await import('@server/routes/system');
const app = createRouteTestApp('/system', systemRoutes);

describe('系统管理路由契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService.prototype, 'log').mockResolvedValue(undefined);
  });

  it('显式保留 null，以支持清空部门负责人', async () => {
    const service = vi.spyOn(SystemService.prototype, 'updateDepartment').mockResolvedValue({ id: 3 } as any);
    const response = await request(app).put('/system/departments/3').send({ leaderId: null });

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(3, expect.objectContaining({ leaderId: null }));
  });

  it('用户更新支持清空组织关系，且不会接受用户名和密码旁路修改', async () => {
    const service = vi.spyOn(SystemService.prototype, 'updateUser').mockResolvedValue({ id: 2 } as any);
    const response = await request(app).put('/system/users/2').send({
      username: 'unexpected-name',
      password: 'unexpected-password',
      departmentId: null,
      groupId: null,
      realName: '更新姓名',
    });

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(2, {
      realName: '更新姓名',
      email: undefined,
      phone: undefined,
      status: undefined,
      departmentId: null,
      groupId: null,
      roleIds: undefined,
    }, 1);
  });

  it('更新角色权限时先去重，避免重复关联和审计噪声', async () => {
    const service = vi.spyOn(SystemService.prototype, 'updateRolePermissions').mockResolvedValue({} as any);
    const response = await request(app).put('/system/roles/4/permissions').send({ permissionIds: [7, 7, 9] });

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(4, [7, 9]);
  });

  it('拒绝超出合理范围的项目工时配额', async () => {
    const service = vi.spyOn(SystemService.prototype, 'addProjectAllocation');
    const response = await request(app).post('/system/projects/1/allocations').send({
      groupId: 2,
      allocation: 1_000_001,
    });

    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('创建项目必须指定负责人，项目编码创建后不可修改', async () => {
    const create = vi.spyOn(SystemService.prototype, 'createProject');
    const missingManager = await request(app).post('/system/projects').send({
      name: '无负责人项目', code: 'NO-MANAGER',
    });
    expect(missingManager.status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const update = vi.spyOn(SystemService.prototype, 'updateProject');
    const changeCode = await request(app).put('/system/projects/1').send({ code: 'NEW-CODE' });
    expect(changeCode.status).toBe(400);
    expect(changeCode.body.message).toContain('创建后不可修改');
    expect(update).not.toHaveBeenCalled();
  });

  it('项目更新权限不再隐式开放全员目录，配置 SE 权限仍可按需读取', async () => {
    const hasPermission = vi.spyOn(AccessPolicyService.prototype, 'hasPermission');
    hasPermission.mockImplementation(async (_viewer, code) => code === 'project:update');
    const getAllUsers = vi.spyOn(SystemService.prototype, 'getAllUsers').mockResolvedValue([] as any);

    const denied = await request(app).get('/system/users/all').set('x-test-role', 'employee');
    expect(denied.status).toBe(403);
    expect(getAllUsers).not.toHaveBeenCalled();

    hasPermission.mockImplementation(async (_viewer, code) => code === 'project:assign_se');
    const allowed = await request(app).get('/system/users/all').set('x-test-role', 'employee');
    expect(allowed.status).toBe(200);
    expect(getAllUsers).toHaveBeenCalledTimes(1);
  });

  it('项目更新同时校验对象范围和负责人分配权限', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canUpdateProject').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(false);
    const update = vi.spyOn(SystemService.prototype, 'updateProject').mockResolvedValue({ id: 1 } as any);

    const managerDenied = await request(app).put('/system/projects/1')
      .set('x-test-role', 'employee')
      .send({ name: '新名称', managerIds: [2] });
    expect(managerDenied.status).toBe(403);
    expect(update).not.toHaveBeenCalled();

    const allowed = await request(app).put('/system/projects/1')
      .set('x-test-role', 'employee')
      .send({ name: '新名称' });
    expect(allowed.status).toBe(200);
    expect(update).toHaveBeenCalledWith(1, expect.objectContaining({ name: '新名称' }));
  });

  it('删除模块 SE 和配额时依据记录所属项目做对象级权限校验', async () => {
    vi.spyOn(SystemService.prototype, 'getProjectSEById').mockResolvedValue({ id: 8, projectId: 21 } as any);
    vi.spyOn(SystemService.prototype, 'getProjectAllocationById').mockResolvedValue({ id: 9, projectId: 22 } as any);
    const removeSe = vi.spyOn(SystemService.prototype, 'removeProjectSE').mockResolvedValue({ affected: 1 } as any);
    const removeAllocation = vi.spyOn(SystemService.prototype, 'removeProjectAllocation').mockResolvedValue({ affected: 1 } as any);
    vi.spyOn(AccessPolicyService.prototype, 'canAssignProjectSE').mockResolvedValue(false);
    vi.spyOn(AccessPolicyService.prototype, 'canUpdateProject').mockResolvedValue(false);

    expect((await request(app).delete('/system/projects/ses/8').set('x-test-role', 'employee')).status).toBe(403);
    expect((await request(app).delete('/system/projects/allocations/9').set('x-test-role', 'employee')).status).toBe(403);
    expect(removeSe).not.toHaveBeenCalled();
    expect(removeAllocation).not.toHaveBeenCalled();
  });

  it('项目列表只返回脱敏关联信息和服务端计算的逐项目操作标志', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'getVisibleProjects').mockResolvedValue([{
      id: 4,
      name: '安全项目',
      code: 'SAFE',
      status: 'active',
      managers: [{ id: 2, realName: '负责人', username: 'manager', password: 'hash' }],
      moduleSEs: [{
        id: 7,
        user: { id: 3, realName: '模块SE', password: 'hash' },
        group: { id: 5, name: '平台组', description: '内部说明' },
      }],
      workloadAllocations: [],
    }] as any);
    vi.spyOn(AccessPolicyService.prototype, 'canUpdateProject').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAssignProjectSE').mockResolvedValue(false);
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission')
      .mockImplementation(async (_viewer, code) => code === 'project:assign_manager');

    const response = await request(app).get('/system/projects/my').set('x-test-role', 'employee');
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      canUpdate: true,
      canAssignSE: false,
      canAssignManager: true,
      canDelete: false,
      managers: [{ id: 2, realName: '负责人' }],
      moduleSEs: [{ user: { id: 3, realName: '模块SE' }, group: { id: 5, name: '平台组' } }],
    });
    expect(JSON.stringify(response.body.data[0])).not.toContain('hash');
  });

  it('组织与项目写接口同样对关联用户脱敏', async () => {
    vi.spyOn(SystemService.prototype, 'updateDepartment').mockResolvedValue({
      id: 3,
      name: '研发部',
      leader: { id: 2, realName: '负责人', password: 'leader-hash', tokenVersion: 7 },
    } as any);
    const department = await request(app).put('/system/departments/3').send({ leaderId: 2 });
    expect(department.status).toBe(200);
    expect(department.body.data.leader).toEqual({ id: 2, realName: '负责人' });
    expect(JSON.stringify(department.body)).not.toContain('leader-hash');

    vi.spyOn(SystemService.prototype, 'createProject').mockResolvedValue({
      id: 8,
      name: '安全项目',
      code: 'SAFE-WRITE',
      managers: [{ id: 2, realName: '负责人', password: 'manager-hash' }],
      moduleSEs: [],
      workloadAllocations: [],
    } as any);
    vi.spyOn(AccessPolicyService.prototype, 'canUpdateProject').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAssignProjectSE').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(true);
    const project = await request(app).post('/system/projects').send({
      name: '安全项目', code: 'SAFE-WRITE', managerIds: [2],
    });
    expect(project.status).toBe(200);
    expect(project.body.data.managers).toEqual([{ id: 2, realName: '负责人' }]);
    expect(JSON.stringify(project.body)).not.toContain('manager-hash');

    vi.spyOn(SystemService.prototype, 'addProjectSE').mockResolvedValue({
      id: 9,
      projectId: 8,
      userId: 3,
      groupId: 4,
      user: { id: 3, realName: '模块SE', password: 'se-hash' },
      group: { id: 4, name: '平台组' },
    } as any);
    const se = await request(app).post('/system/projects/8/ses').send({ userId: 3, groupId: 4 });
    expect(se.status).toBe(200);
    expect(se.body.data.user).toEqual({ id: 3, realName: '模块SE' });
    expect(JSON.stringify(se.body)).not.toContain('se-hash');
  });

  it('普通用户只能读取公开设置，内部槽位与提醒范围不得泄露', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(false);
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      find: vi.fn().mockResolvedValue([
        { id: 1, key: 'system_name', value: 'WorkTime' },
        { id: 2, key: 'timesheet_unit', value: '0.5' },
        { id: 3, key: 'timesheet_reminder_config', value: '{"targetScope":"user"}' },
        { id: 4, key: 'timesheet_reminder_last_slot', value: '2026-07-22 17:30' },
      ]),
    } as any);

    const response = await request(app).get('/system/settings').set('x-test-role', 'employee');

    expect(response.status).toBe(200);
    expect(response.body.data.settings).toEqual({ system_name: 'WorkTime', timesheet_unit: '0.5' });
    expect(response.body.data.list).toHaveLength(2);
  });

  it('设置管理员可读取可管理设置，但同样看不到内部幂等标记', async () => {
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      find: vi.fn().mockResolvedValue([
        { id: 1, key: 'system_name', value: 'WorkTime' },
        { id: 2, key: 'timesheet_reminder_config', value: '{"enabled":false}' },
        { id: 3, key: 'timesheet_reminder_last_slot', value: 'internal' },
      ]),
    } as any);

    const response = await request(app).get('/system/settings');

    expect(response.status).toBe(200);
    expect(response.body.data.settings).toEqual({
      system_name: 'WorkTime',
      timesheet_reminder_config: '{"enabled":false}',
    });
  });

  it('部门与分组写接口严格解析可空负责人和层级关系', async () => {
    const createDepartment = vi.spyOn(SystemService.prototype, 'createDepartment').mockResolvedValue({ id: 1 } as any);
    const createGroup = vi.spyOn(SystemService.prototype, 'createGroup').mockResolvedValue({ id: 2 } as any);
    const updateGroup = vi.spyOn(SystemService.prototype, 'updateGroup').mockResolvedValue({ id: 2 } as any);

    expect((await request(app).post('/system/departments').send({
      name: '研发部', description: '核心研发', leaderId: 3,
    })).status).toBe(200);
    expect(createDepartment).toHaveBeenCalledWith({ name: '研发部', description: '核心研发', leaderId: 3 });

    expect((await request(app).post('/system/groups').send({
      name: '平台组', departmentId: 1, parentId: 4, leaderId: 3,
    })).status).toBe(200);
    expect(createGroup).toHaveBeenCalledWith(expect.objectContaining({ departmentId: 1, parentId: 4, leaderId: 3 }));

    expect((await request(app).put('/system/groups/2').send({ parentId: null, leaderId: '' })).status).toBe(200);
    expect(updateGroup).toHaveBeenCalledWith(2, expect.objectContaining({ parentId: null, leaderId: null }));
  });

  it('用户列表规范化查询，创建时拒绝弱密码和无效联系方式', async () => {
    const getUsers = vi.spyOn(SystemService.prototype, 'getUsers').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 10,
    } as any);
    const listResponse = await request(app).get('/system/users?page=2&pageSize=10&keyword=%20张三%20&departmentId=3');
    expect(listResponse.status).toBe(200);
    expect(getUsers).toHaveBeenCalledWith({
      keyword: '张三', departmentId: 3, groupId: undefined, page: 2, pageSize: 10,
    });

    expect((await request(app).post('/system/users').send({
      username: 'test', password: '1234567', realName: '测试',
    })).status).toBe(400);
    expect((await request(app).post('/system/users').send({
      username: 'test', password: 'password-123', realName: '测试', email: 'bad-email',
    })).status).toBe(400);
  });

  it('管理员不提供密码时生成一次性强随机密码并使旧会话失效', async () => {
    const reset = vi.spyOn(SystemService.prototype, 'resetPassword').mockResolvedValue(undefined);
    const response = await request(app).put('/system/users/9/reset-password').send({});

    expect(response.status).toBe(200);
    const generated = response.body.data.password as string;
    expect(generated.length).toBeGreaterThanOrEqual(32);
    expect(reset).toHaveBeenCalledWith(9, generated);
  });

  it('不能通过管理接口重置当前账号密码', async () => {
    const reset = vi.spyOn(SystemService.prototype, 'resetPassword');

    const response = await request(app).put('/system/users/1/reset-password').send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('个人中心');
    expect(reset).not.toHaveBeenCalled();
  });

  it('自定义角色标识受限且权限 ID 去重', async () => {
    const create = vi.spyOn(SystemService.prototype, 'createRole').mockResolvedValue({ id: 4 } as any);
    const invalid = await request(app).post('/system/roles').send({
      name: 'Admin Role', label: '错误角色', permissionIds: [],
    });
    expect(invalid.status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const valid = await request(app).post('/system/roles').send({
      name: 'finance_reviewer', label: '财务复核员', permissionIds: [2, 2, 3],
    });
    expect(valid.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ permissionIds: [2, 3] }));
  });

  it('权限管理者可独立读取并同步目录，角色管理者只能读取', async () => {
    const getPermissions = vi.spyOn(SystemService.prototype, 'getPermissions').mockResolvedValue([] as any);
    const initPermissions = vi.spyOn(SystemService.prototype, 'initPermissions').mockResolvedValue([{ id: 1 }] as any);

    const permissionManager = await request(app).get('/system/permissions')
      .set('x-test-role', 'employee')
      .set('x-test-permissions', 'system:permission:manage');
    expect(permissionManager.status).toBe(200);
    expect(getPermissions).toHaveBeenCalledTimes(1);

    const synced = await request(app).post('/system/permissions/init')
      .set('x-test-role', 'employee')
      .set('x-test-permissions', 'system:permission:manage');
    expect(synced.status).toBe(200);
    expect(synced.body.message).toBe('权限目录同步成功');
    expect(initPermissions).toHaveBeenCalledTimes(1);
    expect(AuditService.prototype.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'permission.sync_catalog',
      target: 'permission',
    }));

    const roleManagerSync = await request(app).post('/system/permissions/init')
      .set('x-test-role', 'employee')
      .set('x-test-permissions', 'system:role:manage');
    expect(roleManagerSync.status).toBe(403);
    expect(initPermissions).toHaveBeenCalledTimes(1);
  });

  it('审批流程强制至少一个合法步骤，并解析会签与自定义审批人', async () => {
    const create = vi.spyOn(ApprovalFlowEngine.prototype, 'createFlow').mockResolvedValue({ id: 8 } as any);
    expect((await request(app).post('/system/approval-flows').send({
      name: '空流程', type: 'timesheet', steps: [],
    })).status).toBe(400);

    const response = await request(app).post('/system/approval-flows').send({
      name: '工时会签',
      type: 'timesheet',
      enabled: true,
      isDefault: false,
      steps: [{
        stepType: 'custom', label: '财务审批', customApproverId: 7,
        parentLevel: 2, requireAllApprovers: true,
      }],
    });
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'timesheet', enabled: true, isDefault: false,
      steps: [{
        stepType: 'custom', label: '财务审批', customApproverId: 7,
        parentLevel: 2, requireAllApprovers: true,
      }],
    }));
  });

  it('审批流程详情按步骤顺序返回，不存在时为 404', async () => {
    const get = vi.spyOn(ApprovalFlowEngine.prototype, 'getFlow')
      .mockResolvedValueOnce({ id: 1, steps: [{ stepOrder: 2 }, { stepOrder: 1 }] } as any)
      .mockResolvedValueOnce(null);
    const found = await request(app).get('/system/approval-flows/1');
    expect(found.status).toBe(200);
    expect(found.body.data.steps.map((item: any) => item.stepOrder)).toEqual([1, 2]);
    expect((await request(app).get('/system/approval-flows/99')).status).toBe(404);
  });

  it('工时提醒设置在入库前规范化，拒绝扩散风险配置', async () => {
    const repo = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((value) => ({ id: 5, ...value })),
      save: vi.fn(async (value) => value),
    };
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any);
    const invalid = await request(app).put('/system/settings/timesheet_reminder_config').send({
      value: JSON.stringify({
        enabled: true, weekdays: [5], time: '17:30', targetScope: 'departmnt', message: '提醒',
      }),
    });
    expect(invalid.status).toBe(400);
    expect(repo.save).not.toHaveBeenCalled();

    const valid = await request(app).put('/system/settings/timesheet_reminder_config').send({
      value: JSON.stringify({
        enabled: true, weekdays: [5, 1, 5], time: '17:30', targetScope: 'all', message: ' 提醒 ',
      }),
    });
    expect(valid.status).toBe(200);
    expect(JSON.parse(repo.save.mock.calls[0][0].value)).toMatchObject({ weekdays: [1, 5], message: '提醒' });
  });

  it('系统名称不允许保存为空白内容', async () => {
    const repo = { findOne: vi.fn(), save: vi.fn(), create: vi.fn() };
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any);

    const response = await request(app).put('/system/settings/system_name').send({ value: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('系统名称不能为空');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('部门和分组读取接口返回脱敏结构，删除操作记录审计', async () => {
    vi.spyOn(SystemService.prototype, 'getDepartments').mockResolvedValue([{
      id: 2, name: '研发部', users: [{ password: 'secret' }], groups: [],
      leader: { id: 3, realName: '部门负责人', password: 'secret' },
    }] as any);
    vi.spyOn(SystemService.prototype, 'getGroupTree').mockResolvedValue([{ id: 4, name: '平台组' }] as any);
    vi.spyOn(SystemService.prototype, 'getGroups').mockResolvedValue([{
      id: 4, name: '平台组', users: [{ password: 'secret' }], children: [],
      leader: { id: 5, realName: '组长', password: 'secret' },
      department: { id: 2, name: '研发部', description: '内部' },
    }] as any);
    const deleteDepartment = vi.spyOn(SystemService.prototype, 'deleteDepartment').mockResolvedValue(undefined);
    const deleteGroup = vi.spyOn(SystemService.prototype, 'deleteGroup').mockResolvedValue(undefined);

    const departments = await request(app).get('/system/departments');
    expect(departments.status).toBe(200);
    expect(departments.body.data[0].leader).toEqual({ id: 3, realName: '部门负责人' });
    expect(JSON.stringify(departments.body)).not.toContain('secret');

    expect((await request(app).get('/system/groups/tree?departmentId=2')).status).toBe(200);
    expect(SystemService.prototype.getGroupTree).toHaveBeenCalledWith(2);
    const groups = await request(app).get('/system/groups?departmentId=2&parentId=4');
    expect(groups.status).toBe(200);
    expect(SystemService.prototype.getGroups).toHaveBeenCalledWith(2, 4);
    expect(JSON.stringify(groups.body)).not.toContain('secret');

    expect((await request(app).delete('/system/departments/2')).status).toBe(200);
    expect(deleteDepartment).toHaveBeenCalledWith(2);
    expect((await request(app).delete('/system/groups/4')).status).toBe(200);
    expect(deleteGroup).toHaveBeenCalledWith(4);
  });

  it('包含成员和角色的分组树仅向组织或用户管理员开放', async () => {
    const getTree = vi.spyOn(SystemService.prototype, 'getGroupTree').mockResolvedValue([] as any);
    const denied = await request(app).get('/system/groups/tree')
      .set('x-test-role', 'employee')
      .set('x-test-permissions', 'project:access');
    expect(denied.status).toBe(403);
    expect(getTree).not.toHaveBeenCalled();

    const allowed = await request(app).get('/system/groups/tree')
      .set('x-test-role', 'employee')
      .set('x-test-permissions', 'system:user:manage');
    expect(allowed.status).toBe(200);
    expect(getTree).toHaveBeenCalledOnce();
  });

  it('用户创建和删除只传白名单字段，并阻止客户端伪造操作人', async () => {
    const create = vi.spyOn(SystemService.prototype, 'createUser').mockResolvedValue({ id: 9 } as any);
    const remove = vi.spyOn(SystemService.prototype, 'deleteUser').mockResolvedValue(undefined);
    const response = await request(app).post('/system/users').send({
      username: 'new_user', password: 'secure-password', realName: '新用户',
      email: 'new@example.com', phone: '13800000000', departmentId: 2, groupId: 4,
      roleIds: [3, 3, 5], status: 0, actorId: 999,
    });
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith({
      username: 'new_user', password: 'secure-password', realName: '新用户',
      email: 'new@example.com', phone: '13800000000', departmentId: 2, groupId: 4,
      roleIds: [3, 5],
    });
    expect((await request(app).delete('/system/users/9').send({ actorId: 999 })).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(9, 1);
  });

  it('角色列表、更新和删除使用不可变标识并记录当前操作人', async () => {
    const list = vi.spyOn(SystemService.prototype, 'getRoles').mockResolvedValue([{ id: 2, name: 'reviewer' }] as any);
    const update = vi.spyOn(SystemService.prototype, 'updateRole').mockResolvedValue({ id: 2 } as any);
    const remove = vi.spyOn(SystemService.prototype, 'deleteRole').mockResolvedValue(undefined);
    expect((await request(app).get('/system/roles')).status).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect((await request(app).put('/system/roles/2').send({
      name: 'cannot_change', label: '复核员', description: '负责复核', permissionIds: [99],
    })).status).toBe(200);
    expect(update).toHaveBeenCalledWith(2, { label: '复核员', description: '负责复核' });
    expect((await request(app).delete('/system/roles/2')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(2);
  });

  it('进行中项目和可见性状态只返回前端所需字段', async () => {
    vi.spyOn(SystemService.prototype, 'getActiveProjects').mockResolvedValue([{
      id: 2, name: '工时系统', code: 'WT', description: '内部', managers: [{ password: 'secret' }],
    }] as any);
    vi.spyOn(AccessPolicyService.prototype, 'getVisibleProjects').mockResolvedValue([{
      id: 2, name: '工时系统', code: 'WT', managers: [], moduleSEs: [], workloadAllocations: [],
    }] as any);
    vi.spyOn(AccessPolicyService.prototype, 'canUpdateProject').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAssignProjectSE').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'isAdmin').mockReturnValue(false);

    const active = await request(app).get('/system/projects/active');
    expect(active.status).toBe(200);
    expect(active.body.data).toEqual([{ id: 2, name: '工时系统', code: 'WT' }]);
    const canView = await request(app).get('/system/projects/can-view');
    expect(canView.body.data).toEqual({ canView: true, isAdmin: false, isManager: true });
  });

  it('项目删除、SE 和配额读写均在对象级授权后执行', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessProject').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAssignProjectSE').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canUpdateProject').mockResolvedValue(true);
    const deleteProject = vi.spyOn(SystemService.prototype, 'deleteProject').mockResolvedValue(undefined);
    const getSEs = vi.spyOn(SystemService.prototype, 'getProjectSEs').mockResolvedValue([{
      id: 7, projectId: 2, userId: 3, groupId: 4,
      user: { id: 3, realName: '模块SE', password: 'secret' }, group: { id: 4, name: '平台组' },
    }] as any);
    const getAllocations = vi.spyOn(SystemService.prototype, 'getProjectAllocations').mockResolvedValue([{
      id: 8, projectId: 2, groupId: 4, allocation: '20.50', group: { name: '平台组' },
    }] as any);
    const addAllocation = vi.spyOn(SystemService.prototype, 'addProjectAllocation').mockResolvedValue({
      id: 9, projectId: 2, groupId: 4, allocation: 30,
    } as any);
    vi.spyOn(SystemService.prototype, 'getProjectSEById').mockResolvedValue({ id: 7, projectId: 2 } as any);
    vi.spyOn(SystemService.prototype, 'getProjectAllocationById').mockResolvedValue({ id: 8, projectId: 2 } as any);
    const removeSE = vi.spyOn(SystemService.prototype, 'removeProjectSE').mockResolvedValue({ affected: 1 } as any);
    const removeAllocation = vi.spyOn(SystemService.prototype, 'removeProjectAllocation').mockResolvedValue({ affected: 1 } as any);

    expect((await request(app).delete('/system/projects/2')).status).toBe(200);
    expect(deleteProject).toHaveBeenCalledWith(2);
    const ses = await request(app).get('/system/projects/2/ses');
    expect(ses.status).toBe(200);
    expect(getSEs).toHaveBeenCalledWith(2);
    expect(JSON.stringify(ses.body)).not.toContain('secret');
    const allocations = await request(app).get('/system/projects/2/allocations');
    expect(allocations.body.data[0].allocation).toBe(20.5);
    expect(getAllocations).toHaveBeenCalledWith(2);
    expect((await request(app).post('/system/projects/2/allocations').send({ groupId: 4, allocation: 30 })).status).toBe(200);
    expect(addAllocation).toHaveBeenCalledWith({ projectId: 2, groupId: 4, allocation: 30 });
    expect((await request(app).delete('/system/projects/ses/7')).status).toBe(200);
    expect(removeSE).toHaveBeenCalledWith(7);
    expect((await request(app).delete('/system/projects/allocations/8')).status).toBe(200);
    expect(removeAllocation).toHaveBeenCalledWith(8);
  });

  it('审批流程列表、更新和删除保持步骤顺序与字段白名单', async () => {
    const list = vi.spyOn(ApprovalFlowEngine.prototype, 'getFlows').mockResolvedValue([{
      id: 2, steps: [{ stepOrder: 2 }, { stepOrder: 1 }],
    }] as any);
    const update = vi.spyOn(ApprovalFlowEngine.prototype, 'updateFlow').mockResolvedValue({ id: 2 } as any);
    const remove = vi.spyOn(ApprovalFlowEngine.prototype, 'deleteFlow').mockResolvedValue(undefined);
    const listResponse = await request(app).get('/system/approval-flows?type=overtime');
    expect(listResponse.status).toBe(200);
    expect(list).toHaveBeenCalledWith('overtime');
    expect(listResponse.body.data[0].steps.map((step: any) => step.stepOrder)).toEqual([1, 2]);

    const updateResponse = await request(app).put('/system/approval-flows/2').send({
      id: 999, name: '更新流程', enabled: false,
      steps: [{ stepType: 'dept_leader', label: '部门负责人', requireAllApprovers: false }],
    });
    expect(updateResponse.status).toBe(200);
    expect(update).toHaveBeenCalledWith(2, expect.objectContaining({
      name: '更新流程', enabled: false,
      steps: [expect.objectContaining({ stepType: 'dept_leader', label: '部门负责人' })],
    }));
    expect((await request(app).delete('/system/approval-flows/2')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(2);
  });

  it('已有系统设置按键更新并兼容旧工时单位值', async () => {
    const setting = { id: 2, key: 'timesheet_unit', value: '0.25' };
    const repo = {
      findOne: vi.fn().mockResolvedValue(setting),
      create: vi.fn(),
      save: vi.fn(async (value) => value),
    };
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any);
    const response = await request(app).put('/system/settings/timesheet_unit').send({ value: 'days' });
    expect(response.status).toBe(200);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ value: '0.5' }));
  });
});
