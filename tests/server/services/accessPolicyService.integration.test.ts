import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessPolicyService } from '@server/services/accessPolicyService';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { Permission } from '@server/entities/Permission';
import { Project } from '@server/entities/Project';
import { Role } from '@server/entities/Role';
import { User } from '@server/entities/User';
import { UserPermissionGrant } from '@server/entities/UserPermissionGrant';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('AccessPolicyService 项目范围集成', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  async function seedManager(permissionCodes: string[]) {
    const dataSource = getTestDataSource();
    const permissions = await dataSource.getRepository(Permission).save(permissionCodes.map((code) => ({
      code,
      name: code,
      module: 'project',
      action: code.split(':').slice(1).join(':'),
      grantable: false,
      scopeTypes: null,
    })));
    const role = await dataSource.getRepository(Role).save({
      name: `project_role_${permissionCodes.length}_${Math.random().toString(36).slice(2, 7)}`,
      label: '项目角色',
      permissions,
    });
    return dataSource.getRepository(User).save({
      username: `manager_${Math.random().toString(36).slice(2, 7)}`,
      password: 'hash',
      realName: '项目负责人',
      status: 1,
      roles: [role],
    });
  }

  it('仅有项目入口权限时，即使被列为负责人也不能绕过查看权限', async () => {
    const dataSource = getTestDataSource();
    const manager = await seedManager(['project:access']);
    const project = await dataSource.getRepository(Project).save({
      name: '受限项目', code: 'PROJECT-ACCESS-ONLY', status: 'active', managers: [manager],
    });
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: manager.id, roles: ['custom'] };

    expect(await policy.getVisibleProjects(viewer)).toEqual([]);
    expect(await policy.canAccessProject(viewer, project.id)).toBe(false);
  });

  it('拥有“查看负责项目”角色权限时，只能看到本人负责的项目', async () => {
    const dataSource = getTestDataSource();
    const manager = await seedManager(['project:access', 'project:view:managed']);
    const [managed, unrelated] = await dataSource.getRepository(Project).save([
      { name: '负责项目', code: 'PROJECT-MANAGED', status: 'active', managers: [manager] },
      { name: '其他项目', code: 'PROJECT-OTHER', status: 'active', managers: [] },
    ]);
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: manager.id, roles: ['custom'] };

    expect((await policy.getVisibleProjects(viewer)).map(project => project.id)).toEqual([managed.id]);
    expect(await policy.canAccessProject(viewer, managed.id)).toBe(true);
    expect(await policy.canAccessProject(viewer, unrelated.id)).toBe(false);
  });

  it('项目范围授权只开放指定项目，不扩散到其他项目', async () => {
    const dataSource = getTestDataSource();
    const user = await seedManager(['project:access']);
    const permission = await dataSource.getRepository(Permission).save({
      code: 'project:view:managed', name: '查看指定项目', module: 'project', action: 'view:managed',
      grantable: true, scopeTypes: ['project'],
    });
    const [granted, unrelated] = await dataSource.getRepository(Project).save([
      { name: '授权项目', code: 'PROJECT-GRANTED', status: 'active', managers: [] },
      { name: '未授权项目', code: 'PROJECT-NOT-GRANTED', status: 'active', managers: [] },
    ]);
    await dataSource.getRepository(UserPermissionGrant).save({
      userId: user.id,
      permissionId: permission.id,
      permissionCode: permission.code,
      scopeType: 'project',
      scopeId: granted.id,
      scopeName: granted.name,
      source: 'manual',
      status: 'active',
      startsAt: null,
      expiresAt: null,
    });
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: user.id, roles: ['custom'] };

    expect((await policy.getVisibleProjects(viewer)).map(project => project.id)).toEqual([granted.id]);
    expect(await policy.canAccessProject(viewer, granted.id)).toBe(true);
    expect(await policy.canAccessProject(viewer, unrelated.id)).toBe(false);
  });

  it('临时授权只在生效区间内进入权限集合，并返回最近刷新时间', async () => {
    const dataSource = getTestDataSource();
    const user = await seedManager([]);
    const permissions = await dataSource.getRepository(Permission).save([
      {
        code: 'report:view:group', name: '查看组别报表', module: 'report', action: 'view:group',
        grantable: true, scopeTypes: ['group'],
      },
      {
        code: 'report:view:department', name: '查看部门报表', module: 'report', action: 'view:department',
        grantable: true, scopeTypes: ['department'],
      },
      {
        code: 'report:view:project', name: '查看项目报表', module: 'report', action: 'view:project',
        grantable: true, scopeTypes: ['project'],
      },
    ]);
    const now = Date.now();
    await dataSource.getRepository(UserPermissionGrant).save([
      {
        userId: user.id, permissionId: permissions[0].id, permissionCode: permissions[0].code,
        scopeType: 'group', scopeId: 1, source: 'manual', status: 'active',
        startsAt: null, expiresAt: new Date(now + 60_000),
      },
      {
        userId: user.id, permissionId: permissions[1].id, permissionCode: permissions[1].code,
        scopeType: 'department', scopeId: 1, source: 'manual', status: 'active',
        startsAt: new Date(now + 30_000), expiresAt: null,
      },
      {
        userId: user.id, permissionId: permissions[2].id, permissionCode: permissions[2].code,
        scopeType: 'project', scopeId: 1, source: 'manual', status: 'active',
        startsAt: null, expiresAt: new Date(now - 1_000),
      },
    ]);

    const snapshot = await new AccessPolicyService(dataSource.manager)
      .getPermissionSnapshotForLoadedUser({ id: user.id, roles: [] });

    expect(snapshot.permissions.has('report:view:group')).toBe(true);
    expect(snapshot.permissions.has('report:view:department')).toBe(false);
    expect(snapshot.permissions.has('report:view:project')).toBe(false);
    expect(snapshot.refreshAt).toBeGreaterThanOrEqual(now + 29_000);
    expect(snapshot.refreshAt).toBeLessThanOrEqual(now + 31_000);
  });

  it('组负责人可见所有后代组，但不能越过到其他分支', async () => {
    const dataSource = getTestDataSource();
    const manager = await seedManager(['report:view:group']);
    const department = await dataSource.getRepository(Department).save({ name: '研发部' });
    const root = await dataSource.getRepository(Group).save({
      name: '平台组', department, departmentId: department.id, leaderId: manager.id, leader: manager, level: 0,
    });
    const child = await dataSource.getRepository(Group).save({
      name: '子组', department, departmentId: department.id, parent: root, parentId: root.id, level: 1,
    });
    const sibling = await dataSource.getRepository(Group).save({
      name: '其他组', department, departmentId: department.id, level: 0,
    });
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: manager.id, roles: ['custom'] };

    expect(new Set(await policy.getManagedGroupIds(manager.id))).toEqual(new Set([root.id, child.id]));
    expect(await policy.canAccessGroup(viewer, child.id, { allowDepartmentLeader: false })).toBe(true);
    expect(await policy.canAccessGroup(viewer, sibling.id, { allowDepartmentLeader: false })).toBe(false);
    expect(new Set((await policy.getVisibleGroups(viewer)).map(item => item.id)))
      .toEqual(new Set([root.id, child.id]));
  });

  it('部门范围授权允许查看本部门成员，但 scoped 的 all 权限不能被当作全局权限', async () => {
    const dataSource = getTestDataSource();
    const viewerUser = await seedManager([]);
    const department = await dataSource.getRepository(Department).save({ name: '研发部' });
    const otherDepartment = await dataSource.getRepository(Department).save({ name: '财务部' });
    const group = await dataSource.getRepository(Group).save({
      name: '研发一组', department, departmentId: department.id, level: 0,
    });
    const otherGroup = await dataSource.getRepository(Group).save({
      name: '财务一组', department: otherDepartment, departmentId: otherDepartment.id, level: 0,
    });
    const target = await dataSource.getRepository(User).save({
      username: 'target', password: 'hash', realName: '目标成员', status: 1, department, roles: [],
    });
    const outsider = await dataSource.getRepository(User).save({
      username: 'outsider', password: 'hash', realName: '外部成员', status: 1,
      department: otherDepartment, roles: [],
    });
    const permissions = await dataSource.getRepository(Permission).save([
      {
        code: 'report:view:department', name: '部门报表', module: 'report', action: 'view:department',
        grantable: true, scopeTypes: ['department'],
      },
      {
        code: 'report:view:all', name: '全员报表', module: 'report', action: 'view:all',
        grantable: true, scopeTypes: ['global'],
      },
    ]);
    await dataSource.getRepository(UserPermissionGrant).save([
      {
        userId: viewerUser.id, permissionId: permissions[0].id, permissionCode: permissions[0].code,
        scopeType: 'department', scopeId: department.id, source: 'manual', status: 'active',
      },
      {
        userId: viewerUser.id, permissionId: permissions[1].id, permissionCode: permissions[1].code,
        scopeType: 'department', scopeId: department.id, source: 'manual', status: 'active',
      },
    ]);
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: viewerUser.id, roles: ['custom'] };
    const scope = {
      allPermissions: ['report:view:all'],
      departmentPermissions: ['report:view:department'],
    };

    expect(await policy.canAccessUserData(viewer, target.id, scope)).toBe(true);
    expect(await policy.canAccessUserData(viewer, outsider.id, scope)).toBe(false);
    expect(await policy.hasPermission(viewer, 'report:view:all')).toBe(true);
    expect(await policy.hasUnrestrictedPermission(viewer, 'report:view:all')).toBe(false);
    expect((await policy.getVisibleDepartments(viewer)).map(item => item.id)).toEqual([department.id]);
    expect((await policy.getVisibleGroups(viewer)).map(item => item.id)).toEqual([group.id]);
    expect(await policy.canAccessDepartment(viewer, otherDepartment.id)).toBe(false);
    expect(await policy.canAccessGroup(viewer, otherGroup.id)).toBe(false);
    expect(await policy.getVisibleReportProjects(viewer)).toEqual([]);
  });

  it('global 授权将可访问部门范围提升为全量，指定范围授权仍只返回指定部门', async () => {
    const dataSource = getTestDataSource();
    const viewerUser = await seedManager([]);
    const permission = await dataSource.getRepository(Permission).save({
      code: 'report:view:overtime', name: '加班报表', module: 'report', action: 'view:overtime',
      grantable: true, scopeTypes: ['global', 'department'],
    });
    const department = await dataSource.getRepository(Department).save({ name: '研发部' });
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: viewerUser.id, roles: ['custom'] };
    const repo = dataSource.getRepository(UserPermissionGrant);
    const grant = await repo.save({
      userId: viewerUser.id, permissionId: permission.id, permissionCode: permission.code,
      scopeType: 'department', scopeId: department.id, source: 'manual', status: 'active',
    });

    expect(await policy.getAccessibleDepartmentIds(viewer, [permission.code])).toEqual([department.id]);
    await repo.update(grant.id, { scopeType: 'global', scopeId: null });
    expect(await policy.getAccessibleDepartmentIds(viewer, [permission.code])).toBeNull();
  });

  it('范围化导出权限保留部门、展开分组后代且不扩散到其他项目', async () => {
    const dataSource = getTestDataSource();
    const viewerUser = await seedManager([]);
    const permission = await dataSource.getRepository(Permission).save({
      code: 'report:export', name: '报表导出', module: 'report', action: 'export',
      grantable: true, scopeTypes: ['department', 'group', 'project', 'global'],
    });
    const department = await dataSource.getRepository(Department).save({ name: '研发部' });
    const root = await dataSource.getRepository(Group).save({
      name: '平台组', departmentId: department.id, department, level: 0,
    });
    const child = await dataSource.getRepository(Group).save({
      name: '平台子组', departmentId: department.id, department, parentId: root.id, parent: root, level: 1,
    });
    const sibling = await dataSource.getRepository(Group).save({
      name: '其他组', departmentId: department.id, department, level: 0,
    });
    const [grantedProject, otherProject] = await dataSource.getRepository(Project).save([
      { name: '授权项目', code: 'EXPORT-P1', status: 'active', managers: [] },
      { name: '其他项目', code: 'EXPORT-P2', status: 'active', managers: [] },
    ]);
    await dataSource.getRepository(UserPermissionGrant).save([
      {
        userId: viewerUser.id, permissionId: permission.id, permissionCode: permission.code,
        scopeType: 'group', scopeId: root.id, source: 'manual', status: 'active',
      },
      {
        userId: viewerUser.id, permissionId: permission.id, permissionCode: permission.code,
        scopeType: 'project', scopeId: grantedProject.id, source: 'manual', status: 'active',
      },
    ]);
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: viewerUser.id, roles: ['custom'] };

    expect(await policy.getPermissionScope(viewer, permission.code)).toEqual({
      unrestricted: false,
      departmentIds: [],
      groupIds: [root.id, child.id],
      projectIds: [grantedProject.id],
    });
    expect(await policy.hasPermissionAtScope(viewer, permission.code, 'group', child.id)).toBe(true);
    expect(await policy.hasPermissionAtScope(viewer, permission.code, 'group', sibling.id)).toBe(false);
    expect(await policy.hasPermissionAtScope(viewer, permission.code, 'project', otherProject.id)).toBe(false);
  });

  it('项目维度的加班报表权限合并角色负责项目与指定项目授权', async () => {
    const dataSource = getTestDataSource();
    const roleManager = await seedManager(['report:view:overtime']);
    const grantedUser = await seedManager([]);
    const permission = await dataSource.getRepository(Permission).findOneByOrFail({ code: 'report:view:overtime' });
    const [managed, granted, unrelated] = await dataSource.getRepository(Project).save([
      { name: '负责项目', code: 'OVERTIME-MANAGED', status: 'active', managers: [roleManager] },
      { name: '授权项目', code: 'OVERTIME-GRANTED', status: 'active', managers: [] },
      { name: '无关项目', code: 'OVERTIME-OTHER', status: 'active', managers: [] },
    ]);
    await dataSource.getRepository(UserPermissionGrant).save({
      userId: grantedUser.id,
      permissionId: permission.id,
      permissionCode: permission.code,
      scopeType: 'project',
      scopeId: granted.id,
      source: 'manual',
      status: 'active',
    });
    const policy = new AccessPolicyService(dataSource.manager);

    expect(await policy.getAccessibleProjectIds({ id: roleManager.id, roles: ['custom'] }, [permission.code]))
      .toEqual([managed.id]);
    expect(await policy.getAccessibleProjectIds({ id: grantedUser.id, roles: ['custom'] }, [permission.code]))
      .toEqual([granted.id]);
    expect((await policy.getVisibleProjectsForPermissions(
      { id: grantedUser.id, roles: ['custom'] }, [permission.code],
    )).map(project => project.id)).toEqual([granted.id]);
    expect(unrelated.id).not.toBe(granted.id);
  });

  it('角色直接授予全局权限时，部门、组别和项目范围均为不受限', async () => {
    const dataSource = getTestDataSource();
    const viewerUser = await seedManager(['report:view:all', 'project:view:all']);
    const department = await dataSource.getRepository(Department).save({ name: '全局部门' });
    const group = await dataSource.getRepository(Group).save({
      name: '全局组', department, departmentId: department.id, level: 0,
    });
    const project = await dataSource.getRepository(Project).save({
      name: '全局项目', code: 'GLOBAL-PROJECT', status: 'active', managers: [],
    });
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: viewerUser.id, roles: ['custom'] };

    expect(await policy.hasUnrestrictedPermission(viewer, 'report:view:all')).toBe(true);
    expect(await policy.getAccessibleDepartmentIds(viewer, ['report:view:all'])).toBeNull();
    expect((await policy.getVisibleDepartments(viewer)).map(item => item.id)).toEqual([department.id]);
    expect((await policy.getVisibleGroups(viewer)).map(item => item.id)).toEqual([group.id]);
    expect((await policy.getVisibleReportProjects(viewer)).map(item => item.id)).toEqual([project.id]);
    expect(await policy.canAccessDepartment(viewer, department.id)).toBe(true);
    expect(await policy.canAccessGroup(viewer, group.id)).toBe(true);
    expect(await policy.canAccessProject(viewer, project.id)).toBe(true);
    expect(await policy.canAccessProjectReport(viewer, project.id)).toBe(true);
  });

  it('项目编辑和模块 SE 权限只对本人负责或显式授权的项目生效', async () => {
    const dataSource = getTestDataSource();
    const manager = await seedManager(['project:update', 'project:assign_se']);
    const [managed, granted, unrelated] = await dataSource.getRepository(Project).save([
      { name: '本人负责', code: 'MUTATE-MANAGED', status: 'active', managers: [manager] },
      { name: '显式授权', code: 'MUTATE-GRANTED', status: 'active', managers: [] },
      { name: '无关项目', code: 'MUTATE-OTHER', status: 'active', managers: [] },
    ]);
    const updatePermission = await dataSource.getRepository(Permission).findOneByOrFail({ code: 'project:update' });
    await dataSource.getRepository(UserPermissionGrant).save({
      userId: manager.id,
      permissionId: updatePermission.id,
      permissionCode: updatePermission.code,
      scopeType: 'project',
      scopeId: granted.id,
      source: 'manual',
      status: 'active',
    });
    const policy = new AccessPolicyService(dataSource.manager);
    const viewer = { id: manager.id, roles: ['custom'] };

    expect(await policy.canUpdateProject(viewer, managed.id)).toBe(true);
    expect(await policy.canAssignProjectSE(viewer, managed.id)).toBe(true);
    expect(await policy.canUpdateProject(viewer, granted.id)).toBe(true);
    expect(await policy.canAssignProjectSE(viewer, granted.id)).toBe(false);
    expect(await policy.canUpdateProject(viewer, unrelated.id)).toBe(false);
    expect(await policy.canAssignProjectSE(viewer, unrelated.id)).toBe(false);
    expect(await policy.canUpdateProject({ id: 999, roles: ['admin'] }, unrelated.id)).toBe(true);
  });

  it('组织快照和组别归属查询返回当前组织结构且不存在用户安全降级为空快照', async () => {
    const dataSource = getTestDataSource();
    const department = await dataSource.getRepository(Department).save({ name: '组织快照部门' });
    const group = await dataSource.getRepository(Group).save({
      name: '组织快照组', department, departmentId: department.id, level: 0,
    });
    const user = await dataSource.getRepository(User).save({
      username: 'snapshot-user', password: 'hash', realName: '快照用户', status: 1,
      department, group, roles: [],
    });
    const policy = new AccessPolicyService(dataSource.manager);

    expect(await policy.getOrgSnapshot(user.id)).toEqual({
      departmentSnapshotId: department.id,
      departmentSnapshotName: department.name,
      groupSnapshotId: group.id,
      groupSnapshotName: group.name,
    });
    expect(await policy.getOrgSnapshot(999)).toEqual({
      departmentSnapshotId: null,
      departmentSnapshotName: null,
      groupSnapshotId: null,
      groupSnapshotName: null,
    });
    expect(await policy.isGroupInDepartment(group.id, department.id)).toBe(true);
    expect(await policy.isGroupInDepartment(group.id, department.id + 1)).toBe(false);
    expect(await policy.isGroupInDepartment(999, department.id)).toBe(false);
  });
});
