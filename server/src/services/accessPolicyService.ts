import { EntityManager } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Project } from '../entities/Project';
import { User } from '../entities/User';
import { UserPermissionGrant } from '../entities/UserPermissionGrant';
import { expandPermissionCodes, permissionDefinitionMap } from '../config/permissionDefinitions';

export type AccessViewer = {
  id: number;
  roles: string[];
};

export type OrgSnapshot = {
  departmentSnapshotId: number | null;
  departmentSnapshotName: string | null;
  groupSnapshotId: number | null;
  groupSnapshotName: string | null;
};

export type UserDataScopePermissions = {
  allPermissions?: string[];
  departmentPermissions?: string[];
  groupPermissions?: string[];
};

export type PermissionScopeSnapshot = {
  unrestricted: boolean;
  departmentIds: number[];
  groupIds: number[];
  projectIds: number[];
};

export class AccessPolicyService {
  constructor(private manager?: EntityManager) {}

  private get departmentRepo() { return (this.manager ?? AppDataSource).getRepository(Department); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get grantRepo() { return (this.manager ?? AppDataSource).getRepository(UserPermissionGrant); }

  isAdmin(viewer: AccessViewer) {
    return viewer.roles.includes('admin');
  }

  async getRolePermissionCodes(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['roles', 'roles.permissions'],
    });
    const codes = new Set<string>();
    for (const role of user?.roles || []) {
      for (const permission of role.permissions || []) {
        codes.add(permission.code);
      }
    }
    return expandPermissionCodes(codes);
  }

  async getPermissionCodes(userId: number) {
    const codes = new Set(await this.getRolePermissionCodes(userId));
    const now = new Date();
    const grants = await this.grantRepo.find({
      where: { userId, status: 'active' },
    });
    for (const grant of grants) {
      if (grant.startsAt && grant.startsAt > now) continue;
      if (grant.expiresAt && grant.expiresAt <= now) continue;
      codes.add(grant.permissionCode);
    }
    return expandPermissionCodes(codes);
  }

  /**
   * 对已加载（含 roles.permissions 关系）的 user 计算权限集合。
   * 避免在 authMiddleware 已查过 user 后，permissionMiddleware 再重复查询。
   * 仅补充查询 active grants。
   */
  async getPermissionCodesForLoadedUser(user: { id: number; roles?: { permissions?: { code: string }[] }[] } | null) {
    return (await this.getPermissionSnapshotForLoadedUser(user)).permissions;
  }

  /**
   * 同时返回下一次授权状态切换时间，供认证缓存精确失效。
   * 否则即使授权已经到期，缓存中的权限集合仍可能继续生效到固定 TTL 结束。
   */
  async getPermissionSnapshotForLoadedUser(
    user: { id: number; roles?: { permissions?: { code: string }[] }[] } | null,
  ): Promise<{ permissions: Set<string>; refreshAt: number | null }> {
    const codes = new Set<string>();
    for (const role of user?.roles ?? []) {
      for (const permission of role.permissions ?? []) {
        codes.add(permission.code);
      }
    }
    let refreshAt: number | null = null;
    if (user) {
      const now = new Date();
      const grants = await this.grantRepo.find({
        where: { userId: user.id, status: 'active' },
      });
      for (const grant of grants) {
        if (grant.startsAt && grant.startsAt > now) {
          const transition = grant.startsAt.getTime();
          refreshAt = refreshAt === null ? transition : Math.min(refreshAt, transition);
          continue;
        }
        if (grant.expiresAt && grant.expiresAt <= now) continue;
        codes.add(grant.permissionCode);
        if (grant.expiresAt) {
          const transition = grant.expiresAt.getTime();
          refreshAt = refreshAt === null ? transition : Math.min(refreshAt, transition);
        }
      }
    }
    return { permissions: expandPermissionCodes(codes), refreshAt };
  }

  async hasPermission(viewer: AccessViewer, code: string) {
    if (this.isAdmin(viewer)) return true;
    return (await this.getPermissionCodes(viewer.id)).has(code);
  }

  /**
   * 判断权限是否拥有不受限的数据范围。
   * 角色直接赋权和 global 临时授权才代表全量数据；仅持有相同权限码的范围授权不能被放大。
   */
  async hasUnrestrictedPermission(viewer: AccessViewer, code: string) {
    if (this.isAdmin(viewer)) return true;
    if ((await this.getRolePermissionCodes(viewer.id)).has(code)) return true;
    return this.hasGlobalGrant(viewer, [code]);
  }

  private async hasAnyPermission(viewer: AccessViewer, codes: string[] = []) {
    if (!codes.length) return false;
    if (this.isAdmin(viewer)) return true;
    const permissions = await this.getPermissionCodes(viewer.id);
    return codes.some((code) => permissions.has(code));
  }

  private async hasAnyRolePermission(viewer: AccessViewer, codes: string[] = []) {
    if (!codes.length) return false;
    if (this.isAdmin(viewer)) return true;
    const permissions = await this.getRolePermissionCodes(viewer.id);
    return codes.some((code) => permissions.has(code));
  }

  private async hasGlobalGrant(viewer: AccessViewer, codes: string[] = []) {
    if (!codes.length) return false;
    if (this.isAdmin(viewer)) return true;
    for (const code of codes) {
      const grants = await this.getActiveGrants(viewer.id, code);
      if (grants.some((grant) => grant.scopeType === 'global')) return true;
    }
    return false;
  }

  private async hasExplicitUnrestrictedPermission(viewer: AccessViewer, codes: string[]) {
    for (const code of codes) {
      const definition = permissionDefinitionMap.get(code);
      if (definition?.scopeTypes?.length === 1
        && definition.scopeTypes[0] === 'global'
        && await this.hasUnrestrictedPermission(viewer, code)) return true;
    }
    return false;
  }

  async getActiveGrants(userId: number, permissionCode?: string) {
    const grants = await this.grantRepo.createQueryBuilder('grant')
      .where('grant.userId = :userId', { userId })
      .andWhere('grant.status = :status', { status: 'active' })
      .andWhere('(grant.startsAt IS NULL OR grant.startsAt <= :now)', { now: new Date() })
      .andWhere('(grant.expiresAt IS NULL OR grant.expiresAt > :now)', { now: new Date() });
    if (permissionCode) grants.andWhere('grant.permissionCode = :permissionCode', { permissionCode });
    return grants.getMany();
  }

  async hasScopedGrant(viewer: AccessViewer, permissionCode: string, scopeType: string, scopeId?: number | null) {
    if (this.isAdmin(viewer)) return true;
    const grants = await this.getActiveGrants(viewer.id, permissionCode);
    return grants.some((grant) => {
      if (grant.scopeType === 'global') return true;
      if (grant.scopeType !== scopeType) return false;
      return scopeId == null || grant.scopeId === scopeId;
    });
  }

  /**
   * 返回某个可申请权限的实际授权范围。
   * 系统管理员、角色直接赋权或 global 授权视为不受范围限制；临时授权保留并展开分组子树。
   */
  async getPermissionScope(viewer: AccessViewer, permissionCode: string): Promise<PermissionScopeSnapshot> {
    if (this.isAdmin(viewer) || (await this.getRolePermissionCodes(viewer.id)).has(permissionCode)) {
      return { unrestricted: true, departmentIds: [], groupIds: [], projectIds: [] };
    }
    const grants = await this.getActiveGrants(viewer.id, permissionCode);
    if (grants.some((grant) => grant.scopeType === 'global')) {
      return { unrestricted: true, departmentIds: [], groupIds: [], projectIds: [] };
    }
    const departmentIds = Array.from(new Set(grants
      .filter((grant) => grant.scopeType === 'department' && grant.scopeId)
      .map((grant) => grant.scopeId!)));
    const directGroupIds = Array.from(new Set(grants
      .filter((grant) => grant.scopeType === 'group' && grant.scopeId)
      .map((grant) => grant.scopeId!)));
    const projectIds = Array.from(new Set(grants
      .filter((grant) => grant.scopeType === 'project' && grant.scopeId)
      .map((grant) => grant.scopeId!)));
    const groupIds = directGroupIds.length
      ? await this.getGroupAndDescendantIds(directGroupIds)
      : [];
    return { unrestricted: false, departmentIds, groupIds, projectIds };
  }

  async hasPermissionAtScope(
    viewer: AccessViewer,
    permissionCode: string,
    scopeType: 'department' | 'group' | 'project',
    scopeId: number,
  ): Promise<boolean> {
    const scope = await this.getPermissionScope(viewer, permissionCode);
    if (scope.unrestricted) return true;
    if (scopeType === 'department') return scope.departmentIds.includes(scopeId);
    if (scopeType === 'group') return scope.groupIds.includes(scopeId);
    return scope.projectIds.includes(scopeId);
  }

  private async getGrantScopeIds(userId: number, permissionCodes: string[], scopeType: 'department' | 'group' | 'project') {
    const ids = new Set<number>();
    for (const permissionCode of permissionCodes) {
      const grants = await this.getActiveGrants(userId, permissionCode);
      for (const grant of grants) {
        if (grant.scopeType === 'global') return null;
        if (grant.scopeType === scopeType && grant.scopeId) ids.add(grant.scopeId);
      }
    }
    return ids;
  }

  private async hasGroupGrantIncludingDescendants(viewer: AccessViewer, permissionCodes: string[], groupId: number) {
    if (this.isAdmin(viewer)) return true;
    const grantedGroupIds = await this.getGrantScopeIds(viewer.id, permissionCodes, 'group');
    if (grantedGroupIds === null) return true;
    if (!grantedGroupIds.size) return false;
    const visibleGroupIds = await this.getGroupAndDescendantIds(Array.from(grantedGroupIds));
    return visibleGroupIds.includes(groupId);
  }

  async getManagedDepartmentIds(userId: number) {
    const departments = await this.departmentRepo.find({ where: { leaderId: userId } });
    return departments.map((department) => department.id);
  }

  async getGroupAndDescendantIds(rootIds: number[]) {
    if (!rootIds.length) return [];

    const allGroups = await this.groupRepo.find();
    const visible = new Set(rootIds);
    let changed = true;

    while (changed) {
      changed = false;
      for (const group of allGroups) {
        if (group.parentId && visible.has(group.parentId) && !visible.has(group.id)) {
          visible.add(group.id);
          changed = true;
        }
      }
    }

    return Array.from(visible);
  }

  async getManagedGroupIds(userId: number) {
    const groups = await this.groupRepo.find({ where: { leaderId: userId } });
    return this.getGroupAndDescendantIds(groups.map((group) => group.id));
  }

  async getAccessibleDepartmentIds(viewer: AccessViewer, permissionCodes: string[]) {
    if (this.isAdmin(viewer)) return null;
    if (await this.hasGlobalGrant(viewer, permissionCodes)) return null;
    if (await this.hasExplicitUnrestrictedPermission(viewer, permissionCodes)) return null;

    const departmentIds = new Set<number>();
    if (await this.hasAnyRolePermission(viewer, permissionCodes)) {
      for (const id of await this.getManagedDepartmentIds(viewer.id)) departmentIds.add(id);
    }

    const grantedDepartmentIds = await this.getGrantScopeIds(viewer.id, permissionCodes, 'department');
    if (grantedDepartmentIds === null) return null;
    for (const id of grantedDepartmentIds) departmentIds.add(id);
    return Array.from(departmentIds);
  }

  async getAccessibleGroupIds(viewer: AccessViewer, permissionCodes: string[]) {
    if (this.isAdmin(viewer)) return null;
    if (await this.hasGlobalGrant(viewer, permissionCodes)) return null;
    if (await this.hasExplicitUnrestrictedPermission(viewer, permissionCodes)) return null;

    const groupIds = new Set<number>();
    if (await this.hasAnyRolePermission(viewer, permissionCodes)) {
      for (const id of await this.getManagedGroupIds(viewer.id)) groupIds.add(id);
    }

    const grantedGroupIds = await this.getGrantScopeIds(viewer.id, permissionCodes, 'group');
    if (grantedGroupIds === null) return null;
    for (const id of await this.getGroupAndDescendantIds(Array.from(grantedGroupIds))) groupIds.add(id);
    return Array.from(groupIds);
  }

  async getAccessibleProjectIds(viewer: AccessViewer, permissionCodes: string[]) {
    if (this.isAdmin(viewer)) return null;
    const grantedProjectIds = await this.getGrantScopeIds(viewer.id, permissionCodes, 'project');
    if (grantedProjectIds === null) return null;
    if (await this.hasExplicitUnrestrictedPermission(viewer, permissionCodes)) return null;

    const projectIds = new Set(grantedProjectIds);
    if (await this.hasAnyRolePermission(viewer, permissionCodes)) {
      const managed = await this.projectRepo.createQueryBuilder('project')
        .innerJoin('project.managers', 'manager', 'manager.id = :userId', { userId: viewer.id })
        .select('project.id', 'id')
        .getRawMany<{ id: number | string }>();
      for (const project of managed) projectIds.add(Number(project.id));
    }
    return Array.from(projectIds);
  }

  async getVisibleProjectsForPermissions(viewer: AccessViewer, permissionCodes: string[]) {
    const projectIds = await this.getAccessibleProjectIds(viewer, permissionCodes);
    const qb = this.projectRepo.createQueryBuilder('project')
      .select(['project.id', 'project.name', 'project.code', 'project.status'])
      .orderBy('project.createdAt', 'DESC');
    if (projectIds === null) return qb.getMany();
    if (!projectIds.length) return [];
    return qb.where('project.id IN (:...projectIds)', { projectIds }).getMany();
  }

  async getVisibleDepartments(viewer: AccessViewer) {
    if (this.isAdmin(viewer)) {
      return this.departmentRepo.find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    }
    if (await this.hasUnrestrictedPermission(viewer, 'report:view:all')) {
      return this.departmentRepo.find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    }

    const departmentIds = new Set(await this.getManagedDepartmentIds(viewer.id));
    const grantIds = await this.getGrantScopeIds(viewer.id, [
      'report:view:department',
      'report:view:overtime',
      'timesheet:view:department',
      'overtime:view:department',
      'weekly_report:view:department',
    ], 'department');
    if (grantIds === null) {
      return this.departmentRepo.find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    }
    for (const id of grantIds) departmentIds.add(id);
    if (!departmentIds.size) return [];

    return this.departmentRepo.createQueryBuilder('department')
      .leftJoinAndSelect('department.leader', 'leader')
      .where('department.id IN (:...departmentIds)', { departmentIds: Array.from(departmentIds) })
      .orderBy('department.sortOrder', 'ASC')
      .addOrderBy('department.createdAt', 'ASC')
      .getMany();
  }

  async getVisibleGroups(viewer: AccessViewer) {
    if (this.isAdmin(viewer)) {
      return this.groupRepo.find({
        relations: ['leader', 'parent', 'department'],
        order: { level: 'ASC', sortOrder: 'ASC' },
      });
    }
    if (await this.hasUnrestrictedPermission(viewer, 'report:view:all')) {
      return this.groupRepo.find({
        relations: ['leader', 'parent', 'department'],
        order: { level: 'ASC', sortOrder: 'ASC' },
      });
    }

    const departmentIds = new Set(await this.getManagedDepartmentIds(viewer.id));
    const groupIds = new Set(await this.getManagedGroupIds(viewer.id));
    const grantedDepartmentIds = await this.getGrantScopeIds(viewer.id, [
      'report:view:department',
      'report:view:overtime',
      'timesheet:view:department',
      'overtime:view:department',
      'weekly_report:view:department',
    ], 'department');
    const grantedGroupIds = await this.getGrantScopeIds(viewer.id, [
      'report:view:group',
      'report:view:overtime',
      'timesheet:view:group',
      'overtime:view:group',
      'weekly_report:view:group',
    ], 'group');

    if (grantedDepartmentIds === null || grantedGroupIds === null) {
      return this.groupRepo.find({
        relations: ['leader', 'parent', 'department'],
        order: { level: 'ASC', sortOrder: 'ASC' },
      });
    }
    for (const id of grantedDepartmentIds) departmentIds.add(id);
    const grantedGroupDescendantIds = await this.getGroupAndDescendantIds(Array.from(grantedGroupIds));
    for (const id of grantedGroupDescendantIds) groupIds.add(id);

    const qb = this.groupRepo.createQueryBuilder('group')
      .leftJoinAndSelect('group.leader', 'leader')
      .leftJoinAndSelect('group.parent', 'parent')
      .leftJoinAndSelect('group.department', 'department');

    if (departmentIds.size && groupIds.size) {
      qb.where('(group.departmentId IN (:...departmentIds) OR group.id IN (:...groupIds))', {
        departmentIds: Array.from(departmentIds),
        groupIds: Array.from(groupIds),
      });
    } else if (departmentIds.size) {
      qb.where('group.departmentId IN (:...departmentIds)', { departmentIds: Array.from(departmentIds) });
    } else if (groupIds.size) {
      qb.where('group.id IN (:...groupIds)', { groupIds: Array.from(groupIds) });
    } else {
      return [];
    }

    return qb.orderBy('group.level', 'ASC').addOrderBy('group.sortOrder', 'ASC').getMany();
  }

  async getVisibleProjects(viewer: AccessViewer) {
    const qb = this.projectRepo.createQueryBuilder('project')
      .leftJoinAndSelect('project.managers', 'manager')
      .leftJoinAndSelect('project.moduleSEs', 'se')
      .leftJoinAndSelect('se.user', 'seUser')
      .leftJoinAndSelect('se.group', 'seGroup')
      .leftJoinAndSelect('seGroup.department', 'seGroupDepartment')
      .leftJoinAndSelect('project.workloadAllocations', 'alloc')
      .leftJoinAndSelect('alloc.group', 'allocGroup')
      .orderBy('project.createdAt', 'DESC');

    if (!this.isAdmin(viewer)) {
      const rolePermissions = await this.getRolePermissionCodes(viewer.id);
      const canSeeManagedProjects = [
        'project:view:managed',
        'project:update',
        'project:assign_se',
      ].some((code) => rolePermissions.has(code));
      const grantIds = await this.getGrantScopeIds(viewer.id, [
        'project:view:managed',
        'project:update',
        'project:assign_se',
      ], 'project');
      if (grantIds === null || await this.hasUnrestrictedPermission(viewer, 'project:view:all')) {
        return qb.getMany();
      }

      const projectIds = Array.from(grantIds);
      if (canSeeManagedProjects && projectIds.length) {
        qb.where('(manager.id = :userId OR project.id IN (:...projectIds))', { userId: viewer.id, projectIds });
      } else if (canSeeManagedProjects) {
        qb.where('manager.id = :userId', { userId: viewer.id });
      } else if (projectIds.length) {
        qb.where('project.id IN (:...projectIds)', { projectIds });
      } else {
        return [];
      }
    }

    return qb.getMany();
  }

  async getVisibleReportProjects(viewer: AccessViewer) {
    if (await this.hasUnrestrictedPermission(viewer, 'report:view:all')) {
      return this.projectRepo.find({
        relations: ['managers', 'moduleSEs', 'moduleSEs.user', 'moduleSEs.group', 'moduleSEs.group.department'],
        order: { createdAt: 'DESC' },
      });
    }

    const baseProjects = await this.getVisibleProjects(viewer);
    const projectById = new Map(baseProjects.map((project) => [project.id, project]));
    const grantIds = await this.getGrantScopeIds(viewer.id, ['report:view:project'], 'project');

    if (grantIds === null) {
      return this.projectRepo.find({
        relations: ['managers', 'moduleSEs', 'moduleSEs.user', 'moduleSEs.group', 'moduleSEs.group.department'],
        order: { createdAt: 'DESC' },
      });
    }

    const missingIds = Array.from(grantIds).filter((id) => !projectById.has(id));
    if (missingIds.length) {
      const grantedProjects = await this.projectRepo.createQueryBuilder('project')
        .leftJoinAndSelect('project.managers', 'manager')
        .leftJoinAndSelect('project.moduleSEs', 'se')
        .leftJoinAndSelect('se.user', 'seUser')
        .leftJoinAndSelect('se.group', 'seGroup')
        .leftJoinAndSelect('seGroup.department', 'seGroupDepartment')
        .where('project.id IN (:...missingIds)', { missingIds })
        .orderBy('project.createdAt', 'DESC')
        .getMany();
      for (const project of grantedProjects) projectById.set(project.id, project);
    }

    return Array.from(projectById.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async canAccessDepartment(viewer: AccessViewer, departmentId: number) {
    if (this.isAdmin(viewer)) return true;
    if (await this.hasUnrestrictedPermission(viewer, 'report:view:all')) return true;
    const department = await this.departmentRepo.findOne({ where: { id: departmentId } });
    return department?.leaderId === viewer.id
      || await this.hasScopedGrant(viewer, 'report:view:department', 'department', departmentId)
      || await this.hasScopedGrant(viewer, 'report:view:overtime', 'department', departmentId)
      || await this.hasScopedGrant(viewer, 'timesheet:view:department', 'department', departmentId)
      || await this.hasScopedGrant(viewer, 'overtime:view:department', 'department', departmentId)
      || await this.hasScopedGrant(viewer, 'weekly_report:view:department', 'department', departmentId);
  }

  async canAccessGroup(viewer: AccessViewer, groupId: number, options: { allowDepartmentLeader?: boolean } = {}) {
    if (this.isAdmin(viewer)) return true;
    if (await this.hasUnrestrictedPermission(viewer, 'report:view:all')) return true;

    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) return false;

    if (options.allowDepartmentLeader !== false && group.departmentId && await this.canAccessDepartment(viewer, group.departmentId)) {
      return true;
    }

    const groupIds = await this.getManagedGroupIds(viewer.id);
    return groupIds.includes(groupId)
      || await this.hasGroupGrantIncludingDescendants(viewer, [
        'report:view:group',
        'report:view:overtime',
        'timesheet:view:group',
        'overtime:view:group',
        'weekly_report:view:group',
      ], groupId);
  }

  async canAccessProject(viewer: AccessViewer, projectId: number) {
    if (this.isAdmin(viewer)) return true;
    if (await this.hasUnrestrictedPermission(viewer, 'project:view:all')) return true;
    if (await this.hasScopedGrant(viewer, 'project:view:managed', 'project', projectId)
      || await this.hasScopedGrant(viewer, 'project:update', 'project', projectId)
      || await this.hasScopedGrant(viewer, 'project:assign_se', 'project', projectId)) return true;

    const rolePermissions = await this.getRolePermissionCodes(viewer.id);
    const canSeeManagedProject = [
      'project:view:managed',
      'project:update',
      'project:assign_se',
    ].some((code) => rolePermissions.has(code));
    if (!canSeeManagedProject) return false;
    const project = await this.projectRepo.findOne({ where: { id: projectId }, relations: ['managers'] });
    return project?.managers?.some((manager) => manager.id === viewer.id) || false;
  }

  async canUpdateProject(viewer: AccessViewer, projectId: number) {
    if (this.isAdmin(viewer)) return true;
    if (await this.hasScopedGrant(viewer, 'project:update', 'project', projectId)) return true;
    if (!await this.hasPermission(viewer, 'project:update')) return false;
    const project = await this.projectRepo.findOne({ where: { id: projectId }, relations: ['managers'] });
    return project?.managers?.some((manager) => manager.id === viewer.id) || false;
  }

  async canAssignProjectSE(viewer: AccessViewer, projectId: number) {
    if (this.isAdmin(viewer)) return true;
    if (await this.hasScopedGrant(viewer, 'project:assign_se', 'project', projectId)) return true;
    if (!await this.hasPermission(viewer, 'project:assign_se')) return false;
    const project = await this.projectRepo.findOne({ where: { id: projectId }, relations: ['managers'] });
    return project?.managers?.some((manager) => manager.id === viewer.id) || false;
  }

  async canAccessProjectReport(viewer: AccessViewer, projectId: number) {
    if (this.isAdmin(viewer)) return true;
    if (await this.hasUnrestrictedPermission(viewer, 'report:view:all')) return true;
    if (await this.hasScopedGrant(viewer, 'report:view:project', 'project', projectId)) return true;
    return this.canAccessProject(viewer, projectId);
  }

  async canAccessUserData(viewer: AccessViewer, targetUserId: number, permissions: UserDataScopePermissions = {}) {
    if (targetUserId === viewer.id) return true;
    if (this.isAdmin(viewer)) return true;
    // allPermissions（如 report:view:all）必须校验 grant 的 scope 确为 global，
    // 而非仅看权限码集合——防止 scopeType 配错的 grant 触发全员数据可见
    if (permissions.allPermissions?.length && await this.hasGlobalGrant(viewer, permissions.allPermissions)) return true;
    if (await this.hasGlobalGrant(viewer, [
      ...(permissions.departmentPermissions || []),
      ...(permissions.groupPermissions || []),
    ])) return true;

    const targetUser = await this.userRepo.findOne({ where: { id: targetUserId }, relations: ['department', 'group'] });
    if (!targetUser) return false;

    if (targetUser.group?.id) {
      const hasManagedGroupPermission = await this.hasAnyRolePermission(viewer, permissions.groupPermissions);
      const groupIds = hasManagedGroupPermission ? await this.getManagedGroupIds(viewer.id) : [];
      if (groupIds.includes(targetUser.group.id)) return true;
      if (await this.hasGroupGrantIncludingDescendants(viewer, permissions.groupPermissions || [], targetUser.group.id)) return true;
    }

    if (targetUser.department?.id) {
      const hasManagedDepartmentPermission = await this.hasAnyRolePermission(viewer, permissions.departmentPermissions);
      const departmentIds = hasManagedDepartmentPermission ? await this.getManagedDepartmentIds(viewer.id) : [];
      if (departmentIds.includes(targetUser.department.id)) return true;
      for (const code of permissions.departmentPermissions || []) {
        if (await this.hasScopedGrant(viewer, code, 'department', targetUser.department.id)) return true;
      }
    }

    return false;
  }

  async isGroupInDepartment(groupId: number, departmentId: number) {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    return group?.departmentId === departmentId;
  }

  async getOrgSnapshot(userId: number): Promise<OrgSnapshot> {
    const { CacheKeys, cacheGet, cacheSet } = await import('../config/cache');
    const cacheKey = CacheKeys.org(userId);
    const cached = await cacheGet<OrgSnapshot>(cacheKey);
    if (cached) return cached;

    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['department', 'group'],
    });

    const snapshot: OrgSnapshot = {
      departmentSnapshotId: user?.department?.id ?? null,
      departmentSnapshotName: user?.department?.name ?? null,
      groupSnapshotId: user?.group?.id ?? null,
      groupSnapshotName: user?.group?.name ?? null,
    };
    await cacheSet(cacheKey, snapshot);
    return snapshot;
  }
}
