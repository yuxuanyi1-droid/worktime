import { EntityManager } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Project } from '../entities/Project';
import { User } from '../entities/User';
import { UserPermissionGrant } from '../entities/UserPermissionGrant';
import { expandPermissionCodes } from '../config/permissionDefinitions';

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

export class AccessPolicyService {
  constructor(private manager?: EntityManager) {}

  private get departmentRepo() { return (this.manager ?? AppDataSource).getRepository(Department); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get grantRepo() { return (this.manager ?? AppDataSource).getRepository(UserPermissionGrant); }

  /**
   * 进程内 active grants 缓存：key=userId，value={grants, expireAt}。
   * 仅对默认连接（非事务）的 service 实例生效——单例实例（auth/permission/accessControl 中间件等）
   * 跨请求复用，本缓存让一次请求内对同一用户的多次权限/作用域检查（原本是按 permissionCode 循环查询，
   * 典型报表接口可达上百次）退化为「首次 1 次查询 + 后续内存过滤」。
   * 事务内创建的 service 实例（new AccessPolicyService(manager)）不共享本缓存，避免读到事务快照脏数据。
   * TTL 保证权限授予/撤销在最多 TTL 后对所有人可见。
   */
  private static readonly GRANT_CACHE_TTL_MS = 30_000;
  private static grantCache = new Map<number, { grants: UserPermissionGrant[]; expireAt: number }>();

  /** 读取某用户的全部 active grants（带 TTL 缓存，仅默认连接生效）。 */
  private async loadAllActiveGrants(userId: number): Promise<UserPermissionGrant[]> {
    // 事务内不使用缓存：事务连接读到的数据快照与默认连接不同，缓存会引入脏读。
    if (!this.manager) {
      const cached = AccessPolicyService.grantCache.get(userId);
      const now = Date.now();
      if (cached && cached.expireAt > now) return cached.grants;
      const grants = await this.grantRepo.createQueryBuilder('grant')
        .where('grant.userId = :userId', { userId })
        .andWhere('grant.status = :status', { status: 'active' })
        .andWhere('(grant.startsAt IS NULL OR grant.startsAt <= :now)', { now: new Date() })
        .andWhere('(grant.expiresAt IS NULL OR grant.expiresAt > :now)', { now: new Date() })
        .getMany();
      AccessPolicyService.grantCache.set(userId, { grants, expireAt: now + AccessPolicyService.GRANT_CACHE_TTL_MS });
      return grants;
    }
    return this.grantRepo.createQueryBuilder('grant')
      .where('grant.userId = :userId', { userId })
      .andWhere('grant.status = :status', { status: 'active' })
      .andWhere('(grant.startsAt IS NULL OR grant.startsAt <= :now)', { now: new Date() })
      .andWhere('(grant.expiresAt IS NULL OR grant.expiresAt > :now)', { now: new Date() })
      .getMany();
  }

  /** 权限授予发生变更时由 governance 层调用，使下一次读取反映最新状态。 */
  static invalidateGrantCache(userId?: number) {
    if (userId === undefined) AccessPolicyService.grantCache.clear();
    else AccessPolicyService.grantCache.delete(userId);
  }

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
    const codes = new Set<string>();
    for (const role of user?.roles ?? []) {
      for (const permission of role.permissions ?? []) {
        codes.add(permission.code);
      }
    }
    if (user) {
      const now = new Date();
      const grants = await this.grantRepo.find({
        where: { userId: user.id, status: 'active' },
      });
      for (const grant of grants) {
        if (grant.startsAt && grant.startsAt > now) continue;
        if (grant.expiresAt && grant.expiresAt <= now) continue;
        codes.add(grant.permissionCode);
      }
    }
    return expandPermissionCodes(codes);
  }

  async hasPermission(viewer: AccessViewer, code: string) {
    if (this.isAdmin(viewer)) return true;
    return (await this.getPermissionCodes(viewer.id)).has(code);
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
    const codeSet = new Set(codes);
    const grants = await this.getActiveGrants(viewer.id);
    return grants.some((grant) => codeSet.has(grant.permissionCode) && grant.scopeType === 'global');
  }

  async getActiveGrants(userId: number, permissionCode?: string) {
    const grants = await this.loadAllActiveGrants(userId);
    if (!permissionCode) return grants;
    return grants.filter((grant) => grant.permissionCode === permissionCode);
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

  private async getGrantScopeIds(userId: number, permissionCodes: string[], scopeType: 'department' | 'group' | 'project') {
    const ids = new Set<number>();
    // 一次性取该用户全部 active grants（带缓存），在内存里按 codes 集合过滤，
    // 避免对每个 permissionCode 各发一次查询。
    const codeSet = new Set(permissionCodes);
    const grants = await this.getActiveGrants(userId);
    for (const grant of grants) {
      if (!codeSet.has(grant.permissionCode)) continue;
      if (grant.scopeType === 'global') return null;
      if (grant.scopeType === scopeType && grant.scopeId) ids.add(grant.scopeId);
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

    const groupIds = new Set<number>();
    if (await this.hasAnyRolePermission(viewer, permissionCodes)) {
      for (const id of await this.getManagedGroupIds(viewer.id)) groupIds.add(id);
    }

    const grantedGroupIds = await this.getGrantScopeIds(viewer.id, permissionCodes, 'group');
    if (grantedGroupIds === null) return null;
    for (const id of await this.getGroupAndDescendantIds(Array.from(grantedGroupIds))) groupIds.add(id);
    return Array.from(groupIds);
  }

  async getVisibleDepartments(viewer: AccessViewer) {
    if (this.isAdmin(viewer)) {
      return this.departmentRepo.find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    }
    if (await this.hasPermission(viewer, 'report:view:all')) {
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
    if (await this.hasPermission(viewer, 'report:view:all')) {
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
      .orderBy('project.createdAt', 'DESC');

    if (!this.isAdmin(viewer)) {
      const grantIds = await this.getGrantScopeIds(viewer.id, [
        'project:view:managed',
        'project:update',
        'project:assign_se',
      ], 'project');
      if (grantIds === null || await this.hasPermission(viewer, 'project:view:all')) {
        return qb.getMany();
      }

      const projectIds = Array.from(grantIds);
      if (projectIds.length) {
        qb.where('(manager.id = :userId OR project.id IN (:...projectIds))', { userId: viewer.id, projectIds });
      } else {
        qb.where('manager.id = :userId', { userId: viewer.id });
      }
    }

    return qb.getMany();
  }

  async getVisibleReportProjects(viewer: AccessViewer) {
    if (this.isAdmin(viewer) || await this.hasPermission(viewer, 'report:view:all')) {
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
    if (await this.hasPermission(viewer, 'report:view:all')) return true;
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
    if (await this.hasPermission(viewer, 'report:view:all')) return true;

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
    if (await this.hasPermission(viewer, 'project:view:all')) return true;
    const project = await this.projectRepo.findOne({ where: { id: projectId }, relations: ['managers'] });
    return project?.managers?.some((manager) => manager.id === viewer.id)
      || await this.hasScopedGrant(viewer, 'project:view:managed', 'project', projectId)
      || await this.hasScopedGrant(viewer, 'project:update', 'project', projectId)
      || await this.hasScopedGrant(viewer, 'project:assign_se', 'project', projectId)
      || false;
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
    if (await this.hasPermission(viewer, 'report:view:all')) return true;
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
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['department', 'group'],
    });

    return {
      departmentSnapshotId: user?.department?.id ?? null,
      departmentSnapshotName: user?.department?.name ?? null,
      groupSnapshotId: user?.group?.id ?? null,
      groupSnapshotName: user?.group?.name ?? null,
    };
  }
}
