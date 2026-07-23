import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { Permission } from '@server/entities/Permission';
import { Project } from '@server/entities/Project';
import { ProjectSE } from '@server/entities/ProjectSE';
import { ProjectWorkloadAllocation } from '@server/entities/ProjectWorkloadAllocation';
import { Role } from '@server/entities/Role';
import { User } from '@server/entities/User';
import { AuditLog } from '@server/entities/AuditLog';
import { Timesheet } from '@server/entities/Timesheet';
import { SystemService } from '@server/services/systemService';
import { BusinessError } from '@server/utils/errors';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('SystemService 集成', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  async function seedOrg() {
    const dataSource = getTestDataSource();
    const [departmentA, departmentB] = await dataSource.getRepository(Department).save([
      { name: '研发一部' },
      { name: '研发二部' },
    ]);
    const group = await dataSource.getRepository(Group).save({
      name: '平台组',
      departmentId: departmentA.id,
      parentId: null,
      level: 0,
      path: '1',
    });
    return { departmentA, departmentB, group };
  }

  it('创建分组时拒绝无部门顶级组、无效父级和跨部门父子关系', async () => {
    const { departmentB, group } = await seedOrg();
    const service = new SystemService(getTestDataSource().manager);

    await expect(service.createGroup({ name: '无归属组' })).rejects.toThrow('顶级分组必须指定所属部门');
    await expect(service.createGroup({ name: '孤儿组', parentId: 999 })).rejects.toThrow('父级分组不存在');
    await expect(service.createGroup({
      name: '跨部门子组',
      parentId: group.id,
      departmentId: departmentB.id,
    })).rejects.toThrow('子分组必须与父级分组属于同一部门');
  });

  it('同级分组名称不可重复，但不同父级可以同名', async () => {
    const { departmentA, group } = await seedOrg();
    const service = new SystemService(getTestDataSource().manager);

    await expect(service.createGroup({ name: '平台组', departmentId: departmentA.id })).rejects.toThrow('同级分组名称已存在');
    const child = await service.createGroup({ name: '平台组', parentId: group.id });
    expect(child.parentId).toBe(group.id);
    expect(child.departmentId).toBe(departmentA.id);
  });

  it('用户组织关系可以显式清空，切换部门会自动解除不匹配分组', async () => {
    const dataSource = getTestDataSource();
    const { departmentA, departmentB, group } = await seedOrg();
    const user = await dataSource.getRepository(User).save({
      username: 'org-user',
      password: await bcrypt.hash('password-123', 4),
      realName: '组织用户',
      status: 1,
      department: departmentA,
      group,
      roles: [],
    });
    const service = new SystemService(dataSource.manager);

    const moved = await service.updateUser(user.id, { departmentId: departmentB.id });
    expect(moved?.department?.id).toBe(departmentB.id);
    expect(moved?.group).toBeNull();
    expect((moved as any).password).toBeUndefined();
    expect((moved as any).tokenVersion).toBeUndefined();

    const cleared = await service.updateUser(user.id, { departmentId: null, groupId: null });
    expect(cleared?.department).toBeNull();
    expect(cleared?.group).toBeNull();
  });

  it('创建用户返回值不包含密码哈希和会话版本', async () => {
    const dataSource = getTestDataSource();
    const service = new SystemService(dataSource.manager);

    const created = await service.createUser({
      username: 'safe-created-user',
      password: 'password-123',
      realName: '安全用户',
    });

    expect(created).toMatchObject({ username: 'safe-created-user', realName: '安全用户', roles: [] });
    expect((created as any).password).toBeUndefined();
    expect((created as any).tokenVersion).toBeUndefined();
    const stored = await dataSource.getRepository(User).findOneByOrFail({ id: created.id });
    expect(stored.password).not.toBe('password-123');
  });

  it('拒绝自我禁用、移除最后一个管理员及不存在的角色', async () => {
    const dataSource = getTestDataSource();
    const adminRole = await dataSource.getRepository(Role).save({
      name: 'admin',
      label: '管理员',
      isSystem: true,
      permissions: [],
    });
    const admin = await dataSource.getRepository(User).save({
      username: 'only-admin',
      password: await bcrypt.hash('password-123', 4),
      realName: '唯一管理员',
      status: 1,
      roles: [adminRole],
    });
    const service = new SystemService(dataSource.manager);

    await expect(service.updateUser(admin.id, { status: 0 }, admin.id)).rejects.toThrow('不能禁用当前登录账号');
    await expect(service.updateUser(admin.id, { roleIds: [] }, 999)).rejects.toThrow('至少一个启用的管理员');
    await expect(service.updateUser(admin.id, { roleIds: [999] }, 999)).rejects.toThrow('包含不存在的角色');
    await expect(service.deleteUser(admin.id, admin.id)).rejects.toThrow('不能删除当前登录账号');
  });

  it('项目负责人、模块 SE 和配额引用必须真实有效', async () => {
    const dataSource = getTestDataSource();
    const { group } = await seedOrg();
    const service = new SystemService(dataSource.manager);

    await expect(service.createProject({ name: '无效项目', code: 'BAD', managerIds: [999] }))
      .rejects.toThrow('项目管理员中包含不存在的用户');
    await expect(service.createProject({ name: '无负责人项目', code: 'NO-MANAGER' }))
      .rejects.toThrow('至少指定一名项目管理员');

    const project = await dataSource.getRepository(Project).save({ name: '项目A', code: 'A', status: 'active', managers: [] });
    const disabledUser = await dataSource.getRepository(User).save({
      username: 'disabled-se',
      password: await bcrypt.hash('password-123', 4),
      realName: '停用人员',
      status: 0,
      roles: [],
    });
    await expect(service.addProjectSE({ projectId: project.id, userId: disabledUser.id, groupId: group.id }))
      .rejects.toThrow('模块SE已被禁用');
    await expect(service.addProjectAllocation({ projectId: project.id, groupId: 999, allocation: 10 }))
      .rejects.toThrow('分组不存在');

    const activeUser = await dataSource.getRepository(User).save({
      username: 'active-se', password: 'hash', realName: '启用人员', status: 1, roles: [],
    });
    const completed = await dataSource.getRepository(Project).save({
      name: '已完成项目', code: 'COMPLETED', status: 'completed', managers: [activeUser],
    });
    await expect(service.addProjectSE({ projectId: completed.id, userId: activeUser.id, groupId: group.id }))
      .rejects.toThrow('只能为进行中的项目配置模块SE');
    await expect(service.addProjectAllocation({ projectId: completed.id, groupId: group.id, allocation: 10 }))
      .rejects.toThrow('只能配置进行中项目的工时配额');
  });

  it('模块 SE 和工时配额按项目与组并发安全地覆盖，不生成重复记录', async () => {
    const dataSource = getTestDataSource();
    const { group } = await seedOrg();
    const [manager, firstSe, secondSe] = await dataSource.getRepository(User).save([
      { username: 'project-manager', password: 'hash', realName: '项目负责人', status: 1, roles: [] },
      { username: 'first-se', password: 'hash', realName: '第一位SE', status: 1, roles: [] },
      { username: 'second-se', password: 'hash', realName: '第二位SE', status: 1, roles: [] },
    ]);
    const service = new SystemService(dataSource.manager);
    const project = await service.createProject({
      name: '配置覆盖项目', code: 'UPSERT-PROJECT', managerIds: [manager.id],
    });

    await service.addProjectSE({ projectId: project.id, groupId: group.id, userId: firstSe.id });
    const replacedSe = await service.addProjectSE({ projectId: project.id, groupId: group.id, userId: secondSe.id });
    expect(replacedSe.userId).toBe(secondSe.id);
    expect(await dataSource.getRepository(ProjectSE).countBy({ projectId: project.id, groupId: group.id })).toBe(1);

    await service.addProjectAllocation({ projectId: project.id, groupId: group.id, allocation: 10 });
    const replacedAllocation = await service.addProjectAllocation({ projectId: project.id, groupId: group.id, allocation: 18 });
    expect(Number(replacedAllocation.allocation)).toBe(18);
    expect(await dataSource.getRepository(ProjectWorkloadAllocation).countBy({ projectId: project.id, groupId: group.id })).toBe(1);
  });

  it('更新项目保留未提交的负责人，显式清空负责人则拒绝', async () => {
    const dataSource = getTestDataSource();
    const manager = await dataSource.getRepository(User).save({
      username: 'stable-manager', password: 'hash', realName: '稳定负责人', status: 1, roles: [],
    });
    const service = new SystemService(dataSource.manager);
    const project = await service.createProject({ name: '待更新项目', code: 'UPDATE', managerIds: [manager.id] });

    const updated = await service.updateProject(project.id, { name: '更新后项目' });
    expect(updated?.name).toBe('更新后项目');
    expect(updated?.managers.map(item => item.id)).toEqual([manager.id]);
    await expect(service.updateProject(project.id, { managerIds: [] })).rejects.toThrow('至少指定一名项目管理员');
  });

  it('删除项目会清理纯配置，但存在工时记录时必须改为停用而不能删除', async () => {
    const dataSource = getTestDataSource();
    const { group } = await seedOrg();
    const manager = await dataSource.getRepository(User).save({
      username: 'delete-manager', password: 'hash', realName: '删除负责人', status: 1, roles: [],
    });
    const service = new SystemService(dataSource.manager);
    const disposable = await service.createProject({ name: '可删除项目', code: 'DELETE', managerIds: [manager.id] });
    await service.addProjectSE({ projectId: disposable.id, userId: manager.id, groupId: group.id });
    await service.addProjectAllocation({ projectId: disposable.id, groupId: group.id, allocation: 20 });

    await expect(service.deleteProject(disposable.id)).resolves.toMatchObject({ affected: 1 });
    expect(await dataSource.getRepository(Project).findOneBy({ id: disposable.id })).toBeNull();
    expect(await dataSource.getRepository(ProjectSE).countBy({ projectId: disposable.id })).toBe(0);
    expect(await dataSource.getRepository(ProjectWorkloadAllocation).countBy({ projectId: disposable.id })).toBe(0);

    const occupied = await service.createProject({ name: '有工时项目', code: 'OCCUPIED', managerIds: [manager.id] });
    await dataSource.getRepository(Timesheet).save({
      userId: manager.id,
      projectId: occupied.id,
      date: '2026-07-20',
      days: 1,
      status: 'draft',
      currentStep: 0,
      totalSteps: 0,
      departmentSnapshotId: null,
      departmentSnapshotName: null,
      groupSnapshotId: null,
      groupSnapshotName: null,
      approvalFlowId: null,
      approvalInstanceId: null,
      submissionGroupId: null,
      previousGroupId: null,
      rootGroupId: null,
    });
    await expect(service.deleteProject(occupied.id)).rejects.toThrow('建议改为停用');
    expect(await dataSource.getRepository(Project).findOneBy({ id: occupied.id })).not.toBeNull();
  });

  it('角色权限引用必须全部存在，不能静默忽略错误 ID', async () => {
    const dataSource = getTestDataSource();
    const permission = await dataSource.getRepository(Permission).save({
      code: 'timesheet:access',
      name: '工时入口',
      module: 'timesheet',
      action: 'access',
      grantable: false,
      scopeTypes: null,
    });
    const service = new SystemService(dataSource.manager);

    await expect(service.createRole({
      name: 'invalid_role',
      label: '无效角色',
      permissionIds: [permission.id, 999],
    })).rejects.toBeInstanceOf(BusinessError);
  });

  it('权限目录同步会补齐定义并修正存量元数据，返回实际控制说明', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(Permission).save({
      code: 'system:audit:view',
      name: '过期名称',
      module: 'legacy',
      action: 'legacy',
      grantable: true,
      scopeTypes: ['global'],
    });
    const service = new SystemService(dataSource.manager);

    const result = await service.initPermissions();

    const auditPermission = result.find(item => item.code === 'system:audit:view');
    expect(auditPermission).toMatchObject({
      name: '系统管理-审计日志查看',
      module: 'system',
      action: 'audit:view',
      grantable: false,
    });
    expect(result.some(item => item.code === 'timesheet:access')).toBe(true);
    expect(await dataSource.getRepository(Permission).count()).toBeGreaterThan(10);
  });

  it('新建组织节点不能直接指定组织外负责人', async () => {
    const dataSource = getTestDataSource();
    const user = await dataSource.getRepository(User).save({
      username: 'future-leader', password: 'hash', realName: '候选负责人', status: 1, roles: [],
    });
    const department = await dataSource.getRepository(Department).save({ name: '已有部门' });
    const service = new SystemService(dataSource.manager);

    await expect(service.createDepartment({ name: '新部门', leaderId: user.id }))
      .rejects.toThrow('先创建部门并分配成员');
    await expect(service.createGroup({ name: '新分组', departmentId: department.id, leaderId: user.id }))
      .rejects.toThrow('先创建分组并分配成员');
  });

  it('删除部门和分组时在事务内保护现有层级与成员引用', async () => {
    const dataSource = getTestDataSource();
    const service = new SystemService(dataSource.manager);
    const occupiedDepartment = await dataSource.getRepository(Department).save({ name: '占用部门' });
    const root = await dataSource.getRepository(Group).save({
      name: '根组', departmentId: occupiedDepartment.id, parentId: null, level: 0, path: '1',
    });
    await dataSource.getRepository(Group).save({
      name: '子组', departmentId: occupiedDepartment.id, parentId: root.id, level: 1, path: `${root.id}/2`,
    });

    await expect(service.deleteDepartment(occupiedDepartment.id)).rejects.toThrow('还有分组');
    await expect(service.deleteGroup(root.id)).rejects.toThrow('还有子分组');

    const emptyDepartment = await dataSource.getRepository(Department).save({ name: '空部门' });
    await expect(service.deleteDepartment(emptyDepartment.id)).resolves.toMatchObject({ affected: 1 });
    expect(await dataSource.getRepository(Department).findOneBy({ id: emptyDepartment.id })).toBeNull();
  });

  it('只允许删除完全没有业务和审计记录的新账号', async () => {
    const dataSource = getTestDataSource();
    const service = new SystemService(dataSource.manager);
    const fresh = await dataSource.getRepository(User).save({
      username: 'fresh-user', password: 'hash', realName: '新账号', status: 1, roles: [],
    });
    await expect(service.deleteUser(fresh.id, 999)).resolves.toMatchObject({ affected: 1 });
    expect(await dataSource.getRepository(User).findOneBy({ id: fresh.id })).toBeNull();

    const audited = await dataSource.getRepository(User).save({
      username: 'audited-user', password: 'hash', realName: '有审计账号', status: 1, roles: [],
    });
    await dataSource.getRepository(AuditLog).save({
      userId: audited.id, action: 'login', target: 'system', detail: '登录',
    });
    await expect(service.deleteUser(audited.id, 999)).rejects.toThrow('已有业务或审计记录');
    expect(await dataSource.getRepository(User).findOneBy({ id: audited.id })).not.toBeNull();
  });

  it('组织目录和分组树按层级返回，成员信息不包含认证字段', async () => {
    const dataSource = getTestDataSource();
    const { departmentA, group } = await seedOrg();
    const role = await dataSource.getRepository(Role).save({
      name: 'employee', label: '员工', isSystem: true, permissions: [],
    });
    const member = await dataSource.getRepository(User).save({
      username: 'tree-member', password: 'secret-hash', realName: '树成员', status: 1,
      department: departmentA, group, roles: [role], tokenVersion: 7,
    });
    const child = await dataSource.getRepository(Group).save({
      name: '子组', departmentId: departmentA.id, parentId: group.id, level: 1, path: `${group.id}/2`,
    });
    const service = new SystemService(dataSource.manager);
    const departments = await service.getDepartments();
    expect(departments.map((item) => item.name)).toEqual(['研发一部', '研发二部']);
    const flat = await service.getGroups(departmentA.id);
    expect(flat.map((item) => item.id)).toEqual(expect.arrayContaining([group.id, child.id]));
    const tree = await service.getGroupTree(departmentA.id);
    expect(tree[0]).toMatchObject({
      id: group.id,
      members: [{
        id: member.id, username: 'tree-member', realName: '树成员',
        roles: [{ id: role.id, name: 'employee', label: '员工' }],
      }],
      children: [expect.objectContaining({ id: child.id })],
    });
    expect(JSON.stringify(tree)).not.toContain('secret-hash');
    expect(JSON.stringify(tree)).not.toContain('tokenVersion');
  });

  it('移动分组后递归重算自身和全部后代路径与层级', async () => {
    const dataSource = getTestDataSource();
    const { departmentA, group: rootA } = await seedOrg();
    const rootB = await dataSource.getRepository(Group).save({
      name: '业务组', departmentId: departmentA.id, parentId: null, level: 0, path: '2',
    });
    const child = await dataSource.getRepository(Group).save({
      name: '子组', departmentId: departmentA.id, parentId: rootA.id, level: 1, path: `${rootA.id}/3`,
    });
    const grandchild = await dataSource.getRepository(Group).save({
      name: '孙组', departmentId: departmentA.id, parentId: child.id, level: 2, path: `${rootA.id}/${child.id}/4`,
    });
    await new SystemService(dataSource.manager).updateGroup(child.id, { parentId: rootB.id });
    expect(await dataSource.getRepository(Group).findOneByOrFail({ id: child.id }))
      .toMatchObject({ parentId: rootB.id, level: 1, path: `${rootB.id}/${child.id}` });
    expect(await dataSource.getRepository(Group).findOneByOrFail({ id: grandchild.id }))
      .toMatchObject({ level: 2, path: `${rootB.id}/${child.id}/${grandchild.id}` });
  });

  it('用户目录在数据库中筛选分页并只返回管理所需字段', async () => {
    const dataSource = getTestDataSource();
    const { departmentA, departmentB, group } = await seedOrg();
    const role = await dataSource.getRepository(Role).save({
      name: 'reviewer', label: '复核员', isSystem: false, permissions: [],
    });
    await dataSource.getRepository(User).save([
      {
        username: 'zhangsan', password: 'hash-a', realName: '张三', email: 'zhang@example.com',
        status: 1, department: departmentA, group, roles: [role], tokenVersion: 9,
      },
      {
        username: 'lisi', password: 'hash-b', realName: '李四', email: 'li@example.com',
        status: 1, department: departmentB, roles: [], tokenVersion: 8,
      },
    ]);
    const result = await new SystemService(dataSource.manager).getUsers({
      keyword: 'ZHANG', departmentId: departmentA.id, groupId: group.id, page: 1, pageSize: 10,
    });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(result.list[0]).toMatchObject({
      username: 'zhangsan', realName: '张三',
      department: { id: departmentA.id, name: departmentA.name },
      group: { id: group.id, name: group.name },
      roles: [{ id: role.id, name: 'reviewer', label: '复核员' }],
    });
    expect(JSON.stringify(result)).not.toContain('hash-a');
    expect(JSON.stringify(result)).not.toContain('tokenVersion');
  });

  it('重置密码更新哈希并递增 tokenVersion，使既有会话立即失效', async () => {
    const dataSource = getTestDataSource();
    const user = await dataSource.getRepository(User).save({
      username: 'reset-user', password: await bcrypt.hash('old-password', 4), realName: '重置用户',
      status: 1, roles: [], tokenVersion: 3,
    });
    await new SystemService(dataSource.manager).resetPassword(user.id, 'new-password-123');
    const stored = await dataSource.getRepository(User).findOneByOrFail({ id: user.id });
    expect(stored.tokenVersion).toBe(4);
    expect(await bcrypt.compare('new-password-123', stored.password)).toBe(true);
    expect(await bcrypt.compare('old-password', stored.password)).toBe(false);
    await expect(new SystemService(dataSource.manager).resetPassword(999, 'new-password-123'))
      .rejects.toThrow('用户不存在');
  });

  it('自定义角色完整生命周期保持内置角色不可变和权限目录白名单', async () => {
    const dataSource = getTestDataSource();
    const service = new SystemService(dataSource.manager);
    const permissions = await service.initPermissions();
    const timesheetAccess = permissions.find((item) => item.code === 'timesheet:access')!;
    const reportAccess = permissions.find((item) => item.code === 'report:access')!;
    const custom = await service.createRole({
      name: 'custom_reviewer', label: '自定义复核员', permissionIds: [timesheetAccess.id],
    });
    expect(custom).toMatchObject({ userCount: 0, isSystem: false, label: '自定义复核员' });
    expect(custom.permissions.map((item: any) => item.code)).toEqual(['timesheet:access']);
    const updated = await service.updateRole(custom.id, { label: '高级复核员', description: '负责高级复核' });
    expect(updated).toMatchObject({ label: '高级复核员', description: '负责高级复核' });
    const permissionsUpdated = await service.updateRolePermissions(custom.id, [reportAccess.id]);
    expect(permissionsUpdated.permissions.map((item: any) => item.code)).toEqual(['report:access']);
    const roles = await service.getRoles();
    expect(roles.find((item) => item.id === custom.id)).toMatchObject({ userCount: 0 });
    await service.deleteRole(custom.id);
    expect(await dataSource.getRepository(Role).findOneBy({ id: custom.id })).toBeNull();

    const systemRole = await dataSource.getRepository(Role).save({
      name: 'employee', label: '员工', isSystem: true, permissions: [], users: [],
    });
    await expect(service.updateRole(systemRole.id, { label: '不可修改' })).rejects.toThrow('不可重命名');
    await expect(service.deleteRole(systemRole.id)).rejects.toThrow('不可删除');
  });

  it('项目辅助查询只返回启用项目、负责项目和当前有效用户', async () => {
    const dataSource = getTestDataSource();
    const { departmentA, group } = await seedOrg();
    const [manager, other] = await dataSource.getRepository(User).save([
      {
        username: 'query-manager', password: 'hash', realName: '查询负责人', status: 1,
        department: departmentA, group, roles: [],
      },
      { username: 'query-other', password: 'hash', realName: '其他用户', status: 0, roles: [] },
    ]);
    const service = new SystemService(dataSource.manager);
    const active = await service.createProject({ name: '启用项目', code: 'QUERY-ACTIVE', managerIds: [manager.id] });
    await dataSource.getRepository(Project).save({
      name: '停用项目', code: 'QUERY-STOPPED', status: 'suspended', managers: [manager],
    });
    expect((await service.getProjects()).map((item) => item.code)).toEqual(expect.arrayContaining(['QUERY-ACTIVE', 'QUERY-STOPPED']));
    expect((await service.getActiveProjects()).map((item) => item.code)).toEqual(['QUERY-ACTIVE']);
    expect((await service.getMyManagedProjects(manager.id)).map((item) => item.id)).toContain(active.id);
    await expect(service.isUserProjectManager(manager.id)).resolves.toBe(true);
    await expect(service.isUserProjectManager(other.id)).resolves.toBe(false);
    await expect(service.isUserManagerOfProject(manager.id, active.id)).resolves.toBe(true);
    await expect(service.isUserManagerOfProject(other.id, active.id)).resolves.toBe(false);
    expect(await service.getAllUsers()).toEqual([expect.objectContaining({
      id: manager.id, departmentId: departmentA.id, groupId: group.id,
    })]);
  });

  it('项目组工时消耗只统计审批中和已通过记录', async () => {
    const dataSource = getTestDataSource();
    const { departmentA, group } = await seedOrg();
    const user = await dataSource.getRepository(User).save({
      username: 'consumption-user', password: 'hash', realName: '配额用户', status: 1,
      department: departmentA, group, roles: [],
    });
    const project = await dataSource.getRepository(Project).save({
      name: '配额项目', code: 'CONSUMPTION', status: 'active', managers: [user],
    });
    await dataSource.getRepository(Timesheet).save([
      { userId: user.id, projectId: project.id, date: '2026-07-20', days: 1, status: 'submitted' },
      { userId: user.id, projectId: project.id, date: '2026-07-21', days: 0.5, status: 'approved' },
      { userId: user.id, projectId: project.id, date: '2026-07-22', days: 1, status: 'draft' },
      { userId: user.id, projectId: project.id, date: '2026-07-23', days: 1, status: 'deprecated' },
    ]);
    await expect(new SystemService(dataSource.manager).getGroupProjectConsumption(project.id, group.id))
      .resolves.toBe(1.5);
  });
});
