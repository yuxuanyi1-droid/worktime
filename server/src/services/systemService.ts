import { EntityManager, In, IsNull, Not } from 'typeorm';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Role } from '../entities/Role';
import { Permission } from '../entities/Permission';
import { Project } from '../entities/Project';
import { ProjectSE } from '../entities/ProjectSE';
import { ProjectWorkloadAllocation } from '../entities/ProjectWorkloadAllocation';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { ApprovalTask } from '../entities/ApprovalTask';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { ApprovalFlowStep } from '../entities/ApprovalFlowStep';
import { PermissionRequest } from '../entities/PermissionRequest';
import { Notification } from '../entities/Notification';
import { Announcement } from '../entities/Announcement';
import { AnnouncementRead } from '../entities/AnnouncementRead';
import { AuditLog } from '../entities/AuditLog';
import bcrypt from 'bcryptjs';
import {
  permissionDefinitionMap,
  permissionDefinitions,
  permissionImplications,
} from '../config/permissionDefinitions';
import { BusinessError } from '../utils/errors';
import {
  CacheKeys,
  CacheTtl,
  cacheGetOrLoad,
  invalidateAuthUser,
  invalidateAuthUsers,
  invalidateOrgCatalog,
  invalidateOrgSnapshot,
  invalidateProjectApproval,
  invalidateProjectCatalog,
} from '../config/cache';

export class SystemService {
  constructor(private manager?: EntityManager) {}

  private get deptRepo() { return (this.manager ?? AppDataSource).getRepository(Department); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get roleRepo() { return (this.manager ?? AppDataSource).getRepository(Role); }
  private get permRepo() { return (this.manager ?? AppDataSource).getRepository(Permission); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }
  private get projectSERepo() { return (this.manager ?? AppDataSource).getRepository(ProjectSE); }
  private get allocationRepo() { return (this.manager ?? AppDataSource).getRepository(ProjectWorkloadAllocation); }
  private get timesheetRepo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get overtimeRepo() { return (this.manager ?? AppDataSource).getRepository(OvertimeApplication); }
  private get weeklyReportRepo() { return (this.manager ?? AppDataSource).getRepository(WeeklyReport); }
  private get approvalInstanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get approvalTaskRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalTask); }
  private get approvalRecordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get approvalFlowStepRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalFlowStep); }
  private get permissionRequestRepo() { return (this.manager ?? AppDataSource).getRepository(PermissionRequest); }
  private get notificationRepo() { return (this.manager ?? AppDataSource).getRepository(Notification); }
  private get announcementRepo() { return (this.manager ?? AppDataSource).getRepository(Announcement); }
  private get announcementReadRepo() { return (this.manager ?? AppDataSource).getRepository(AnnouncementRead); }
  private get auditRepo() { return (this.manager ?? AppDataSource).getRepository(AuditLog); }

  private transaction<T>(work: (manager: EntityManager) => Promise<T>) {
    if (this.manager?.queryRunner?.isTransactionActive) return work(this.manager);
    return (this.manager?.connection ?? AppDataSource).transaction(work);
  }

  private async requireDepartment(id: number) {
    const department = await this.deptRepo.findOneBy({ id });
    if (!department) throw new BusinessError('部门不存在');
    return department;
  }

  private async requireGroup(id: number) {
    const group = await this.groupRepo.findOneBy({ id });
    if (!group) throw new BusinessError('分组不存在');
    return group;
  }

  private async requireActiveUser(id: number, field = '用户') {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BusinessError(`${field}不存在`);
    if (Number(user.status) !== 1) throw new BusinessError(`${field}已被禁用`);
    return user;
  }

  private async resolveUsers(ids: number[], field: string) {
    const uniqueIds = Array.from(new Set(ids));
    if (!uniqueIds.length) return [];
    const users = await this.userRepo.findBy({ id: In(uniqueIds) });
    if (users.length !== uniqueIds.length) throw new BusinessError(`${field}中包含不存在的用户`);
    if (users.some(user => Number(user.status) !== 1)) throw new BusinessError(`${field}中包含已禁用用户`);
    return users;
  }

  private async resolveRoles(ids: number[]) {
    const uniqueIds = Array.from(new Set(ids));
    if (!uniqueIds.length) return [];
    const roles = await this.roleRepo.findBy({ id: In(uniqueIds) });
    if (roles.length !== uniqueIds.length) throw new BusinessError('包含不存在的角色');
    return roles;
  }

  /** 系统管理接口可返回的用户字段；任何写接口都不能把密码哈希或 tokenVersion 回传给前端。 */
  private presentManagedUser(user: User) {
    return {
      id: user.id,
      username: user.username,
      realName: user.realName,
      email: user.email,
      phone: user.phone,
      status: user.status,
      department: user.department ? { id: user.department.id, name: user.department.name } : null,
      group: user.group ? { id: user.group.id, name: user.group.name } : null,
      roles: (user.roles || []).map(role => ({ id: role.id, name: role.name, label: role.label })),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // ==================== 部门管理 ====================

  async getDepartments() {
    const cacheKey = CacheKeys.departments();
    return cacheGetOrLoad(cacheKey, CacheTtl.org, () => (
      this.deptRepo.find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } })
    ));
  }

  async createDepartment(data: { name: string; description?: string; leaderId?: number }) {
    if (data.leaderId) {
      throw new BusinessError('请先创建部门并分配成员，再设置部门负责人');
    }
    if (await this.deptRepo.findOne({ where: { name: data.name } })) {
      throw new BusinessError('部门名称已存在');
    }
    const deptData: any = { name: data.name, description: data.description };
    const dept = this.deptRepo.create(deptData) as unknown as Department;
    const result = await this.deptRepo.save(dept);
    await invalidateOrgCatalog();
    return result;
  }

  async updateDepartment(id: number, data: { name?: string; description?: string; leaderId?: number | null }) {
    await this.requireDepartment(id);
    if (data.name && await this.deptRepo.findOne({ where: { name: data.name, id: Not(id) } })) {
      throw new BusinessError('部门名称已存在');
    }
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.leaderId !== undefined) {
      if (data.leaderId === null) {
        updateData.leader = null;
      } else {
        const leader = await this.requireActiveUser(data.leaderId, '部门负责人');
        if (leader.department?.id !== id) {
          const member = await this.userRepo.findOne({ where: { id: data.leaderId }, relations: ['department'] });
          if (member?.department?.id !== id) throw new BusinessError('部门负责人必须是该部门成员');
        }
        updateData.leader = { id: data.leaderId };
      }
    }
    await this.deptRepo.save({ id, ...updateData });
    const result = await this.deptRepo.findOne({ where: { id }, relations: ['leader'] });
    await invalidateOrgCatalog();
    return result;
  }

  async deleteDepartment(id: number) {
    const result = await this.transaction(async manager => {
      const txService = new SystemService(manager);
      const department = await txService.deptRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!department) throw new BusinessError('部门不存在');
      const [userCount, groupCount] = await Promise.all([
        txService.userRepo.count({ where: { department: { id } } }),
        txService.groupRepo.count({ where: { departmentId: id } }),
      ]);
      if (userCount > 0) throw new BusinessError('该部门下还有用户，无法删除');
      if (groupCount > 0) throw new BusinessError('该部门下还有分组，无法删除');
      return txService.deptRepo.delete(id);
    });
    await invalidateOrgCatalog();
    return result;
  }

  // ==================== 分组管理（多层级树形） ====================

  /** 获取分组树 */
  async getGroupTree(departmentId?: number) {
    const cacheKey = CacheKeys.groupTree(departmentId);
    return cacheGetOrLoad(cacheKey, CacheTtl.org, async () => {
      const where: any = {};
      if (departmentId) where.departmentId = departmentId;
      const allGroups = await this.groupRepo.find({
        where,
        relations: ['leader', 'parent', 'users', 'users.roles'],
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
      return this.buildGroupTree(allGroups);
    });
  }

  /** 获取平铺列表 */
  async getGroups(departmentId?: number, parentId?: number) {
    const cacheKey = CacheKeys.groups(departmentId, parentId);
    return cacheGetOrLoad(cacheKey, CacheTtl.org, () => {
      const where: any = {};
      if (departmentId) where.departmentId = departmentId;
      if (parentId !== undefined) where.parentId = parentId || null;
      return this.groupRepo.find({
        where,
        relations: ['leader', 'parent', 'department'],
        order: { level: 'ASC', sortOrder: 'ASC' },
      });
    });
  }

  private buildGroupTree(groups: Group[], parentId: number | null = null): any[] {
    return groups
      .filter(g => (parentId === null ? !g.parentId : g.parentId === parentId))
      .map(g => ({
        id: g.id,
        name: g.name,
        description: g.description,
        departmentId: g.departmentId,
        parentId: g.parentId,
        leaderId: g.leaderId,
        sortOrder: g.sortOrder,
        level: g.level,
        path: g.path,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        leader: g.leader ? { id: g.leader.id, realName: g.leader.realName } : null,
        members: (g.users || []).map(u => ({
          id: u.id,
          realName: u.realName,
          username: u.username,
          roles: (u.roles || []).map(r => ({ id: r.id, name: r.name, label: r.label })),
        })),
        children: this.buildGroupTree(groups, g.id),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * 计算新分组的父级路径信息。
   * 返回父组的 level 和 path（不含自身 id，自身 id 在 createGroup 保存后拼接）。
   * 顶级组（无 parentId）：level=0，path 将在保存后设为自身 id。
   */
  private async computeGroupPath(parentId: number | null): Promise<{ level: number; parentPath: string | null; departmentId: number | null }> {
    if (!parentId) return { level: 0, parentPath: null, departmentId: null };

    const parent = await this.groupRepo.findOneBy({ id: parentId });
    if (!parent) throw new BusinessError('父级分组不存在');

    return {
      level: (parent.level || 0) + 1,
      // 父组的完整 path（如 "1/3"），子组保存后拼接为 "1/3/7"
      parentPath: parent.path || null,
      departmentId: parent.departmentId,
    };
  }

  async createGroup(data: { name: string; description?: string; departmentId?: number; parentId?: number; leaderId?: number }) {
    if (data.leaderId) {
      throw new BusinessError('请先创建分组并分配成员，再设置分组负责人');
    }
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const parentId = data.parentId || null;
      const pathInfo = await txService.computeGroupPath(parentId);
      if (parentId && data.departmentId && data.departmentId !== pathInfo.departmentId) {
        throw new BusinessError('子分组必须与父级分组属于同一部门');
      }
      const deptId = data.departmentId || pathInfo.departmentId;
      if (!deptId) throw new BusinessError('顶级分组必须指定所属部门');
      await txService.requireDepartment(deptId);
      const duplicate = await txService.groupRepo.findOne({
        where: { name: data.name, departmentId: deptId, parentId: parentId ?? IsNull() },
      });
      if (duplicate) throw new BusinessError('同级分组名称已存在');

      const groupData: any = {
        name: data.name,
        description: data.description,
        departmentId: deptId,
        parentId,
        level: pathInfo.level,
        path: '',
      };
      const group = txService.groupRepo.create(groupData);
      const saved = await txService.groupRepo.save(group) as unknown as Group;
      saved.path = pathInfo.parentPath ? `${pathInfo.parentPath}/${saved.id}` : `${saved.id}`;
      return txService.groupRepo.save(saved);
    });
    await invalidateOrgCatalog();
    return result;
  }

  async updateGroup(id: number, data: { name?: string; description?: string; departmentId?: number | null; parentId?: number | null; leaderId?: number | null }) {
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const group = await txService.groupRepo.findOne({ where: { id } });
      if (!group) throw new BusinessError('分组不存在');

      const nextParentId = data.parentId !== undefined ? data.parentId : group.parentId;

      // 防止循环引用
      if (nextParentId) {
        if (nextParentId === id) throw new BusinessError('不能将自己设为父级');
        let checkId: number | null = nextParentId;
        while (checkId) {
          if (checkId === id) throw new BusinessError('不能形成循环引用');
          const p = await txService.groupRepo.findOne({ where: { id: checkId } });
          if (!p) throw new BusinessError('父级分组不存在');
          checkId = p?.parentId ?? null;
        }
      }

      const parent = nextParentId ? await txService.requireGroup(nextParentId) : null;
      if (parent && data.departmentId != null && data.departmentId !== parent.departmentId) {
        throw new BusinessError('子分组必须与父级分组属于同一部门');
      }
      const nextDepartmentId = parent?.departmentId
        ?? (data.departmentId !== undefined ? data.departmentId : group.departmentId);
      if (!nextDepartmentId) throw new BusinessError('顶级分组必须指定所属部门');
      await txService.requireDepartment(nextDepartmentId);
      if (nextDepartmentId !== group.departmentId) {
        const groups = await txService.groupRepo.find();
        const subtreeIds = new Set<number>([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of groups) {
            if (candidate.parentId && subtreeIds.has(candidate.parentId) && !subtreeIds.has(candidate.id)) {
              subtreeIds.add(candidate.id);
              changed = true;
            }
          }
        }
        const memberCount = await txService.userRepo.count({
          where: { group: { id: In(Array.from(subtreeIds)) } },
        });
        if (memberCount > 0) throw new BusinessError('分组及其子分组仍有成员，不能跨部门移动');
      }

      const nextName = data.name ?? group.name;
      const duplicate = await txService.groupRepo.findOne({
        where: { id: Not(id), name: nextName, departmentId: nextDepartmentId, parentId: nextParentId ?? IsNull() },
      });
      if (duplicate) throw new BusinessError('同级分组名称已存在');

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.leaderId !== undefined) {
        if (data.leaderId === null) {
          updateData.leader = null;
        } else {
          const leader = await txService.userRepo.findOne({ where: { id: data.leaderId }, relations: ['group'] });
          if (!leader) throw new BusinessError('分组负责人不存在');
          if (Number(leader.status) !== 1) throw new BusinessError('分组负责人已被禁用');
          if (leader.group?.id !== id) throw new BusinessError('分组负责人必须是该分组成员');
          updateData.leader = { id: data.leaderId };
        }
      }
      updateData.parentId = nextParentId;
      updateData.departmentId = nextDepartmentId;
      updateData.level = parent ? parent.level + 1 : 0;
      await txService.groupRepo.save({ id, ...updateData });

      if (nextParentId !== group.parentId || nextDepartmentId !== group.departmentId) {
        await txService.repathGroup(id);
      }
      return txService.groupRepo.findOne({ where: { id }, relations: ['leader', 'parent', 'department'] });
    });
    await invalidateOrgCatalog();
    return result;
  }

  /**
   * 重新计算某分组及其所有子孙分组的 path。
   * 在父级变更时调用，保证整棵子树的路径一致。
   */
  private async repathGroup(groupId: number) {
    const allGroups = await this.groupRepo.find();
    const byId = new Map(allGroups.map(g => [g.id, g]));
    const root = byId.get(groupId);
    if (!root) return;

    // 先把 root 的父级信息更新进 map（root.parentId/level 可能刚被 updateGroup 改过）
    const freshRoot = await this.groupRepo.findOne({ where: { id: groupId } });
    if (freshRoot) byId.set(groupId, freshRoot);

    const stack: number[] = [groupId];
    const updates: Group[] = [];
    const setPath = (g: Group) => {
      const parent = g.parentId ? byId.get(g.parentId) : null;
      g.path = parent?.path ? `${parent.path}/${g.id}` : `${g.id}`;
      g.level = parent ? parent.level + 1 : 0;
      if (parent) g.departmentId = parent.departmentId;
      updates.push(g);
    };

    setPath(byId.get(groupId)!);
    while (stack.length) {
      const current = stack.pop()!;
      for (const g of allGroups) {
        if (g.parentId === current) {
          setPath(g);
          stack.push(g.id);
        }
      }
    }
    await this.groupRepo.save(updates);
  }

  async deleteGroup(id: number) {
    const result = await this.transaction(async manager => {
      const txService = new SystemService(manager);
      const group = await txService.groupRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!group) throw new BusinessError('分组不存在');
      const [childCount, userCount, seCount, allocationCount] = await Promise.all([
        txService.groupRepo.count({ where: { parentId: id } }),
        txService.userRepo.count({ where: { group: { id } } }),
        txService.projectSERepo.count({ where: { groupId: id } }),
        txService.allocationRepo.count({ where: { groupId: id } }),
      ]);
      if (childCount > 0) throw new BusinessError('该分组下还有子分组，无法删除');
      if (userCount > 0) throw new BusinessError('该分组下还有用户，无法删除');
      if (seCount + allocationCount > 0) throw new BusinessError('该分组仍被项目配置引用，无法删除');
      return txService.groupRepo.delete(id);
    });
    await invalidateOrgCatalog();
    return result;
  }

  // ==================== 用户管理 ====================
  async getUsers(params: { keyword?: string; departmentId?: number; groupId?: number; page?: number; pageSize?: number }) {
    const { keyword, departmentId, groupId, page = 1, pageSize = 20 } = params;
    const qb = this.userRepo.createQueryBuilder('u')
      .leftJoinAndSelect('u.department', 'dept')
      .leftJoinAndSelect('u.group', 'grp')
      .leftJoinAndSelect('u.roles', 'role');

    if (keyword) {
      qb.andWhere('(LOWER(u.username) LIKE LOWER(:kw) OR LOWER(u.realName) LIKE LOWER(:kw) OR LOWER(u.email) LIKE LOWER(:kw))', { kw: `%${keyword}%` });
    }
    if (departmentId) {
      qb.andWhere('u.departmentId = :deptId', { deptId: departmentId });
    }
    if (groupId) {
      qb.andWhere('u.groupId = :grpId', { grpId: groupId });
    }

    qb.orderBy('u.createdAt', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    return {
      list: list.map(u => ({
        id: u.id,
        username: u.username,
        realName: u.realName,
        email: u.email,
        phone: u.phone,
        status: u.status,
        department: u.department ? { id: u.department.id, name: u.department.name } : null,
        group: u.group ? { id: u.group.id, name: u.group.name } : null,
        roles: u.roles.map(r => ({ id: r.id, name: r.name, label: r.label })),
        createdAt: u.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async createUser(data: { username: string; password: string; realName: string; email?: string; phone?: string; departmentId?: number; groupId?: number; roleIds?: number[] }) {
    const existing = await this.userRepo.findOne({ where: { username: data.username } });
    if (existing) throw new BusinessError('用户名已存在');

    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const group = data.groupId ? await txService.requireGroup(data.groupId) : null;
      if (group && data.departmentId && group.departmentId !== data.departmentId) {
        throw new BusinessError('用户所属分组与部门不一致');
      }
      const departmentId = group?.departmentId ?? data.departmentId;
      if (departmentId) await txService.requireDepartment(departmentId);
      const userData: any = {
        username: data.username,
        password: await bcrypt.hash(data.password, 10),
        realName: data.realName,
        email: data.email,
        phone: data.phone,
      };
      userData.department = departmentId ? { id: departmentId } : null;
      userData.group = group ? { id: group.id } : null;
      userData.roles = await txService.resolveRoles(data.roleIds || []);

      const user = txService.userRepo.create(userData) as unknown as User;
      return txService.userRepo.save(user);
    });
    await invalidateOrgCatalog();
    const created = await this.userRepo.findOne({
      where: { id: result.id },
      relations: ['department', 'group', 'roles'],
    });
    if (!created) throw new BusinessError('用户创建后读取失败');
    return this.presentManagedUser(created);
  }

  async updateUser(id: number, data: { realName?: string; email?: string; phone?: string; status?: number; departmentId?: number | null; groupId?: number | null; roleIds?: number[] }, actorId?: number) {
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const lockedUser = await txService.userRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!lockedUser) throw new BusinessError('用户不存在');
      const user = await txService.userRepo.findOneOrFail({ where: { id }, relations: ['department', 'group', 'roles'] });
      if (actorId === id && data.status === 0) throw new BusinessError('不能禁用当前登录账号');
      if (data.status === 0 && Number(user.status) === 1) {
        const [ledDepartment, ledGroup, seCount, managedProjectCount] = await Promise.all([
          txService.deptRepo.findOne({ where: { leaderId: id } }),
          txService.groupRepo.findOne({ where: { leaderId: id } }),
          txService.projectSERepo.count({ where: { userId: id } }),
          txService.projectRepo.createQueryBuilder('project')
            .innerJoin('project.managers', 'manager')
            .where('manager.id = :id', { id })
            .getCount(),
        ]);
        if (ledDepartment || ledGroup || seCount > 0 || managedProjectCount > 0) {
          throw new BusinessError('该用户仍承担组织或项目审批职责，请先完成负责人交接');
        }
      }

      let nextGroup: Group | null = user.group ?? null;
      if (data.groupId !== undefined) {
        nextGroup = data.groupId === null ? null : await txService.requireGroup(data.groupId);
      }
      let nextDepartmentId = data.departmentId !== undefined
        ? data.departmentId
        : user.department?.id ?? null;
      if (data.departmentId !== undefined && data.groupId === undefined && user.group?.departmentId !== nextDepartmentId) {
        // 管理员切换部门时，旧分组不再合法；自动解除比保存出矛盾归属更符合表单预期。
        nextGroup = null;
      }
      if (nextGroup) {
        if (data.departmentId != null && data.departmentId !== nextGroup.departmentId) {
          throw new BusinessError('用户所属分组与部门不一致');
        }
        nextDepartmentId = nextGroup.departmentId;
      } else if (nextDepartmentId) {
        await txService.requireDepartment(nextDepartmentId);
      }

      const currentDepartmentId = user.department?.id ?? null;
      const currentGroupId = user.group?.id ?? null;
      if (currentDepartmentId !== nextDepartmentId) {
        const ledDepartment = await txService.deptRepo.findOne({ where: { leaderId: id } });
        if (ledDepartment) throw new BusinessError('该用户仍是部门负责人，请先重新指定负责人');
      }
      if (currentGroupId !== (nextGroup?.id ?? null)) {
        const ledGroup = await txService.groupRepo.findOne({ where: { leaderId: id } });
        if (ledGroup) throw new BusinessError('该用户仍是分组负责人，请先重新指定负责人');
      }

      // 所有可能改变管理员有效性的操作先锁定同一 admin 角色行，避免两名管理员并发互相降权后留下零管理员。
      if (data.status !== undefined || data.roleIds !== undefined) {
        await txService.roleRepo.findOne({ where: { name: 'admin' }, lock: { mode: 'pessimistic_write' } });
      }
      const nextRoles = data.roleIds !== undefined
        ? await txService.resolveRoles(data.roleIds)
        : user.roles;
      const currentlyActiveAdmin = Number(user.status) === 1 && user.roles.some(role => role.name === 'admin');
      const remainsActiveAdmin = (data.status ?? user.status) === 1 && nextRoles.some(role => role.name === 'admin');
      if (currentlyActiveAdmin && !remainsActiveAdmin) {
        const remainingAdmins = await txService.userRepo.createQueryBuilder('user')
          .innerJoin('user.roles', 'role')
          .where('user.status = :status', { status: 1 })
          .andWhere('role.name = :role', { role: 'admin' })
          .andWhere('user.id != :id', { id })
          .getCount();
        if (remainingAdmins === 0) throw new BusinessError('系统必须保留至少一个启用的管理员账号');
      }

      const updateData: any = {};
      if (data.realName !== undefined) updateData.realName = data.realName;
      if (data.email !== undefined) updateData.email = data.email || null;
      if (data.phone !== undefined) updateData.phone = data.phone || null;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.departmentId !== undefined || data.groupId !== undefined) {
        updateData.department = nextDepartmentId ? { id: nextDepartmentId } : null;
        updateData.group = nextGroup ? { id: nextGroup.id } : null;
      }
      if (data.roleIds !== undefined) updateData.roles = nextRoles;

      await txService.userRepo.save({ id, ...updateData });
      return txService.userRepo.findOne({ where: { id }, relations: ['department', 'group', 'roles'] });
    });
    if (data.departmentId !== undefined || data.groupId !== undefined || data.realName !== undefined) {
      await invalidateOrgSnapshot(id);
    }
    await Promise.all([invalidateAuthUser(id), invalidateOrgCatalog()]);
    return this.presentManagedUser(result!);
  }

  async deleteUser(id: number, actorId?: number) {
    const result = await this.transaction(async manager => {
      const txService = new SystemService(manager);
      const lockedUser = await txService.userRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!lockedUser) throw new BusinessError('用户不存在');
      const user = await txService.userRepo.findOneOrFail({ where: { id }, relations: ['roles'] });
      if (actorId === id) throw new BusinessError('不能删除当前登录账号');
      if (Number(user.status) === 1 && user.roles.some(role => role.name === 'admin')) {
        await txService.roleRepo.findOne({ where: { name: 'admin' }, lock: { mode: 'pessimistic_write' } });
        const activeAdminCount = await txService.userRepo.createQueryBuilder('user')
          .innerJoin('user.roles', 'role')
          .where('user.status = :status', { status: 1 })
          .andWhere('role.name = :role', { role: 'admin' })
          .getCount();
        if (activeAdminCount <= 1) throw new BusinessError('系统必须保留至少一个启用的管理员账号');
      }
      const [ledDepartment, ledGroup] = await Promise.all([
        txService.deptRepo.findOne({ where: { leaderId: id } }),
        txService.groupRepo.findOne({ where: { leaderId: id } }),
      ]);
      if (ledDepartment || ledGroup) throw new BusinessError('该用户仍是组织负责人，请先重新指定负责人');

      // 所有历史/流程引用都必须保留；仅允许删除刚创建且尚未参与业务的账号。
      const counts = await Promise.all([
        txService.timesheetRepo.count({ where: { userId: id } }),
        txService.overtimeRepo.count({ where: { userId: id } }),
        txService.weeklyReportRepo.count({ where: { userId: id } }),
        txService.projectSERepo.count({ where: { userId: id } }),
        txService.approvalInstanceRepo.count({ where: { applicantId: id } }),
        txService.approvalTaskRepo.count({ where: [{ approverId: id }, { actedById: id }] }),
        txService.approvalRecordRepo.count({ where: { approverId: id } }),
        txService.approvalFlowStepRepo.count({ where: { customApproverId: id } }),
        txService.permissionRequestRepo.count({ where: { applicantId: id } }),
        txService.notificationRepo.count({ where: { userId: id } }),
        txService.announcementRepo.count({ where: { createdById: id } }),
        txService.announcementReadRepo.count({ where: { userId: id } }),
        txService.auditRepo.count({ where: { userId: id } }),
      ]);
      const managedProjectCount = await txService.projectRepo.createQueryBuilder('project')
        .innerJoin('project.managers', 'manager')
        .where('manager.id = :id', { id })
        .getCount();
      if (managedProjectCount > 0 || counts.some(count => count > 0)) {
        throw new BusinessError('该用户已有业务或审计记录，无法删除（建议改为禁用）');
      }
      return txService.userRepo.delete(id);
    });
    await Promise.all([invalidateAuthUser(id), invalidateOrgSnapshot(id), invalidateOrgCatalog()]);
    return result;
  }

  async resetPassword(id: number, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BusinessError('用户不存在');
    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion += 1;
    const result = await this.userRepo.save(user);
    await invalidateAuthUser(id);
    return result;
  }

  // ==================== 角色权限 ====================
  async getRoles() {
    const roles = await this.roleRepo.find({ relations: ['permissions', 'users'], order: { isSystem: 'DESC', id: 'ASC' } });
    return roles.map(role => ({
      ...role,
      permissions: role.permissions
        .filter(permission => permissionDefinitionMap.has(permission.code))
        .map(permission => this.presentPermission(permission)),
      userCount: role.users.length,
      users: undefined,
    }));
  }

  async createRole(data: { name: string; label: string; description?: string; permissionIds?: number[] }) {
    const result = await this.transaction(async manager => {
      const txService = new SystemService(manager);
      const existing = await txService.roleRepo.findOne({ where: { name: data.name } });
      if (existing) throw new BusinessError('角色标识已存在');
      const permissions = await txService.resolveAssignablePermissions(data.permissionIds || []);
      const role = txService.roleRepo.create({
        name: data.name,
        label: data.label,
        description: data.description || null,
        isSystem: false,
        permissions,
      });
      return txService.roleRepo.save(role);
    });
    await invalidateOrgCatalog();
    return this.getRole(result.id);
  }

  async updateRole(id: number, data: { label?: string; description?: string }) {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new BusinessError('角色不存在');
    if (role.isSystem) throw new BusinessError('系统内置角色不可重命名');
    if (data.label !== undefined) role.label = data.label;
    if (data.description !== undefined) role.description = data.description;
    await this.roleRepo.save(role);
    await invalidateOrgCatalog();
    return this.getRole(id);
  }

  async deleteRole(id: number) {
    await this.transaction(async manager => {
      const txService = new SystemService(manager);
      const lockedRole = await txService.roleRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!lockedRole) throw new BusinessError('角色不存在');
      const role = await txService.roleRepo.findOneOrFail({ where: { id }, relations: ['users', 'permissions'] });
      if (role.isSystem) throw new BusinessError('系统内置角色不可删除');
      if (role.users.length) throw new BusinessError(`该角色仍分配给${role.users.length}名用户，请先解除关联`);
      role.permissions = [];
      await txService.roleRepo.save(role);
      await txService.roleRepo.remove(role);
    });
    await invalidateOrgCatalog();
  }

  async updateRolePermissions(roleId: number, permissionIds: number[]) {
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const role = await txService.roleRepo.findOne({ where: { id: roleId }, relations: ['permissions'] });
      if (!role) throw new BusinessError('角色不存在');
      if (role.name === 'admin') throw new BusinessError('管理员角色始终拥有全部权限，无需修改');
      role.permissions = await txService.resolveAssignablePermissions(permissionIds);
      return txService.roleRepo.save(role);
    });
    const roleWithUsers = await this.roleRepo.findOne({ where: { id: roleId }, relations: ['users'] });
    await Promise.all([
      invalidateAuthUsers((roleWithUsers?.users || []).map((user) => user.id)),
      invalidateOrgCatalog(),
    ]);
    return { ...result, permissions: result.permissions.map(permission => this.presentPermission(permission)) };
  }

  async getPermissions() {
    const permissions = await this.permRepo.find({ order: { module: 'ASC', action: 'ASC' } });
    return permissions
      .filter(permission => permissionDefinitionMap.has(permission.code))
      .map(permission => this.presentPermission(permission));
  }

  private async getRole(id: number) {
    const role = await this.roleRepo.findOne({ where: { id }, relations: ['permissions', 'users'] });
    if (!role) throw new BusinessError('角色不存在');
    return {
      ...role,
      permissions: role.permissions
        .filter(permission => permissionDefinitionMap.has(permission.code))
        .map(permission => this.presentPermission(permission)),
      userCount: role.users.length,
      users: undefined,
    };
  }

  private presentPermission(permission: Permission) {
    const definition = permissionDefinitionMap.get(permission.code);
    return {
      ...permission,
      name: definition?.name || permission.name,
      description: definition?.description,
      impliedPermissions: permissionImplications[permission.code] || [],
    };
  }

  private async resolveAssignablePermissions(permissionIds: number[]) {
    const uniqueIds = Array.from(new Set(permissionIds));
    if (!uniqueIds.length) return [];
    const permissions = await this.permRepo.findBy({ id: In(uniqueIds) });
    if (permissions.length !== uniqueIds.length) throw new BusinessError('包含不存在的权限');
    const unavailable = permissions.find(permission => !permissionDefinitionMap.has(permission.code));
    if (unavailable) throw new BusinessError(`权限“${unavailable.name}”已从权限目录移除`);
    return permissions;
  }

  async initPermissions() {
    await this.transaction(async manager => {
      const txService = new SystemService(manager);
      for (const def of permissionDefinitions) {
        const existing = await txService.permRepo.findOne({ where: { code: def.code } });
        if (!existing) {
          await txService.permRepo.save(txService.permRepo.create({
            ...def,
            grantable: !!def.grantable,
            scopeTypes: def.scopeTypes ?? null,
          }));
        } else {
          await txService.permRepo.save({
            ...existing,
            name: def.name,
            module: def.module,
            action: def.action,
            grantable: !!def.grantable,
            scopeTypes: def.scopeTypes ?? null,
          });
        }
      }
    });
    return this.getPermissions();
  }

  // ==================== 项目管理 ====================
  async getProjects() {
    return this.projectRepo.find({
      relations: ['managers', 'moduleSEs', 'moduleSEs.user', 'moduleSEs.group'],
      order: { createdAt: 'DESC' },
    });
  }

  async createProject(data: { name: string; code: string; description?: string; managerIds?: number[] }) {
    if (!data.managerIds?.length) throw new BusinessError('请至少指定一名项目管理员');
    const existing = await this.projectRepo.findOne({ where: { code: data.code } });
    if (existing) throw new BusinessError('项目编码已存在');
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const projectData: any = { name: data.name, code: data.code, description: data.description };
      projectData.managers = await txService.resolveUsers(data.managerIds || [], '项目管理员');
      const project = txService.projectRepo.create(projectData) as unknown as Project;
      return txService.projectRepo.save(project);
    });
    await invalidateProjectCatalog();
    return result;
  }

  async updateProject(id: number, data: { name?: string; description?: string; status?: string; managerIds?: number[] }) {
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const existing = await txService.projectRepo.findOneBy({ id });
      if (!existing) throw new BusinessError('项目不存在');
      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.managerIds !== undefined) {
        if (!data.managerIds.length) throw new BusinessError('请至少指定一名项目管理员');
        updateData.managers = await txService.resolveUsers(data.managerIds, '项目管理员');
      }
      await txService.projectRepo.save({ id, ...updateData });
      return txService.projectRepo.findOne({ where: { id }, relations: ['managers'] });
    });
    if (data.managerIds !== undefined) {
      await invalidateProjectApproval(id);
    }
    await invalidateProjectCatalog();
    return result;
  }

  async deleteProject(id: number) {
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const project = await txService.projectRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!project) throw new BusinessError('项目不存在');
      // 检查与删除必须处于同一事务，避免检查后又插入工时造成竞态和原始外键错误。
      const [timesheetCount, overtimeCount] = await Promise.all([
        txService.timesheetRepo.count({ where: { projectId: id } }),
        txService.overtimeRepo.count({ where: { projectId: id } }),
      ]);
      if (timesheetCount + overtimeCount > 0) {
        throw new BusinessError('该项目存在关联工时/加班记录，无法删除（建议改为停用）');
      }
      await txService.projectSERepo.delete({ projectId: id });
      await txService.allocationRepo.delete({ projectId: id });
      return txService.projectRepo.delete(id);
    });
    await Promise.all([invalidateProjectApproval(id), invalidateProjectCatalog()]);
    return result;
  }

  // ==================== 项目SE管理 ====================
  async getProjectSEs(projectId: number) {
    return this.projectSERepo.find({
      where: { projectId },
      relations: ['user', 'group'],
    });
  }

  async addProjectSE(data: { projectId: number; userId: number; groupId: number }) {
    const result = await this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const project = await txService.projectRepo.findOneBy({ id: data.projectId });
      if (!project) throw new BusinessError('项目不存在');
      if (project.status !== 'active') throw new BusinessError('只能为进行中的项目配置模块SE');
      const [user, group] = await Promise.all([
        txService.requireActiveUser(data.userId, '模块SE'),
        txService.requireGroup(data.groupId),
      ]);
      await txService.projectSERepo.upsert({
        ...data,
        userName: user.realName,
        groupName: group.name,
      }, { conflictPaths: ['projectId', 'groupId'] });
      return txService.projectSERepo.findOneOrFail({
        where: { projectId: data.projectId, groupId: data.groupId },
        relations: ['user', 'group'],
      });
    });
    await invalidateProjectApproval(data.projectId);
    return result;
  }

  async removeProjectSE(id: number) {
    const existing = await this.projectSERepo.findOne({ where: { id } });
    const result = await this.projectSERepo.delete(id);
    if (existing?.projectId) await invalidateProjectApproval(existing.projectId);
    return result;
  }

  // ==================== 项目工时配额管理 ====================

  async getProjectAllocations(projectId: number) {
    return this.allocationRepo.find({
      where: { projectId },
      relations: ['group'],
      order: { createdAt: 'ASC' },
    });
  }

  /** upsert：同一项目同一组只保留一条配额记录，重复提交则更新 allocation 值 */
  async addProjectAllocation(data: { projectId: number; groupId: number; allocation: number }) {
    return this.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const [project, group] = await Promise.all([
        txService.projectRepo.findOneBy({ id: data.projectId }),
        txService.requireGroup(data.groupId),
      ]);
      if (!project) throw new BusinessError('项目不存在');
      if (project.status !== 'active') throw new BusinessError('只能配置进行中项目的工时配额');
      await txService.allocationRepo.upsert({
        ...data,
        groupName: group.name,
      }, { conflictPaths: ['projectId', 'groupId'] });
      return txService.allocationRepo.findOneOrFail({
        where: { projectId: data.projectId, groupId: data.groupId },
        relations: ['group'],
      });
    });
  }

  async removeProjectAllocation(id: number) {
    return this.allocationRepo.delete(id);
  }

  /** 按 id 查单条配额（DELETE 路由先查 projectId 做权限校验用） */
  async getProjectAllocationById(id: number) {
    return this.allocationRepo.findOne({ where: { id } });
  }

  /**
   * 统计某组在某项目的已消耗工时（人/天）。
   * 消耗口径：status IN ('submitted','approved')（审批中 + 已通过），排除 draft/deprecated/rejected。
   * 统计范围：该组所有成员在该项目的工时总和（配额是组级共享额度）。
   */
  async getGroupProjectConsumption(projectId: number, groupId: number): Promise<number> {
    const result = await this.timesheetRepo
      .createQueryBuilder('t')
      .innerJoin('users', 'u', 'u.id = t.userId')
      .where('t.projectId = :projectId', { projectId })
      .andWhere('u.groupId = :groupId', { groupId })
      .andWhere('t.status IN (:...statuses)', { statuses: ['submitted', 'approved'] })
      .select('COALESCE(SUM(t.days), 0)', 'total')
      .getRawOne();
    return Number(result?.total || 0);
  }

  /** 获取所有用户列表（供选择器用，含部门/组归属以便前端按归属过滤负责人人选） */
  async getAllUsers() {
    // department/group 是 ManyToOne 关系，外键 id 不会自动出现在实体实例上，
    // 需加载关系后从 u.department?.id / u.group?.id 取值。
    const users = await this.userRepo.find({
      where: { status: 1 },
      relations: ['department', 'group'],
      order: { realName: 'ASC' },
    });
    return users.map(u => ({
      id: u.id,
      username: u.username,
      realName: u.realName,
      departmentId: u.department?.id ?? null,
      groupId: u.group?.id ?? null,
    }));
  }

  // ==================== 项目管理员 ====================

  /** 获取当前用户作为管理员负责的项目（用 join where 直接查，避免全表扫+内存过滤） */
  async getMyManagedProjects(userId: number) {
    return this.projectRepo.createQueryBuilder('project')
      .leftJoinAndSelect('project.managers', 'manager')
      .leftJoinAndSelect('project.moduleSEs', 'se')
      .leftJoinAndSelect('se.user', 'seUser')
      .leftJoinAndSelect('se.group', 'seGroup')
      .where('manager.id = :userId', { userId })
      .orderBy('project.createdAt', 'DESC')
      .getMany();
  }

  /** 检查用户是否是某个项目的管理员（用 COUNT 查询，避免全表加载） */
  async isUserProjectManager(userId: number): Promise<boolean> {
    const count = await this.projectRepo.createQueryBuilder('project')
      .leftJoin('project.managers', 'manager')
      .where('manager.id = :userId', { userId })
      .getCount();
    return count > 0;
  }

  /** 检查用户是否是系统管理员 */
  async isUserAdmin(userId: number): Promise<boolean> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['roles'],
    });
    if (!user) return false;
    return user.roles.some(r => r.name === 'admin');
  }

  /** 获取进行中的项目列表（供工时/加班选择） */
  async getActiveProjects() {
    const cacheKey = CacheKeys.activeProjects();
    return cacheGetOrLoad(cacheKey, CacheTtl.project, () => this.projectRepo.find({
      where: { status: 'active' },
      order: { name: 'ASC' },
    }));
  }

  /** 检查用户是否是指定项目的管理员 */
  async isUserManagerOfProject(userId: number, projectId: number): Promise<boolean> {
    const count = await this.projectRepo.createQueryBuilder('project')
      .leftJoin('project.managers', 'manager')
      .where('project.id = :projectId', { projectId })
      .andWhere('manager.id = :userId', { userId })
      .getCount();
    return count > 0;
  }

  /** 获取单个项目SE记录 */
  async getProjectSEById(id: number) {
    return this.projectSERepo.findOne({ where: { id } });
  }
}
