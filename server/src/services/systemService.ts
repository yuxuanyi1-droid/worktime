import { EntityManager } from 'typeorm';
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
import bcrypt from 'bcryptjs';
import { In } from 'typeorm';
import { permissionDefinitions } from '../config/permissionDefinitions';
import { BusinessError } from '../utils/errors';

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

  // ==================== 部门管理 ====================

  async getDepartments() {
    return this.deptRepo.find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } });
  }

  async createDepartment(data: { name: string; description?: string; leaderId?: number }) {
    const deptData: any = { name: data.name, description: data.description };
    if (data.leaderId) deptData.leader = { id: data.leaderId };
    const dept = this.deptRepo.create(deptData);
    return this.deptRepo.save(dept);
  }

  async updateDepartment(id: number, data: { name?: string; description?: string; leaderId?: number }) {
    const updateData: any = { ...data };
    if (data.leaderId !== undefined) {
      updateData.leader = data.leaderId ? { id: data.leaderId } : null;
    }
    delete updateData.leaderId;
    await this.deptRepo.save({ id, ...updateData });
    return this.deptRepo.findOne({ where: { id }, relations: ['leader'] });
  }

  async deleteDepartment(id: number) {
    const userCount = await this.userRepo.count({ where: { department: { id } } });
    if (userCount > 0) throw new BusinessError('该部门下还有用户，无法删除');
    return this.deptRepo.delete(id);
  }

  // ==================== 分组管理（多层级树形） ====================

  /** 获取分组树 */
  async getGroupTree(departmentId?: number) {
    const where: any = {};
    if (departmentId) where.departmentId = departmentId;
    const allGroups = await this.groupRepo.find({
      where,
      relations: ['leader', 'parent', 'users', 'users.roles'],
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return this.buildGroupTree(allGroups);
  }

  /** 获取平铺列表 */
  async getGroups(departmentId?: number, parentId?: number) {
    const where: any = {};
    if (departmentId) where.departmentId = departmentId;
    if (parentId !== undefined) where.parentId = parentId || null;
    return this.groupRepo.find({
      where,
      relations: ['leader', 'parent', 'department'],
      order: { level: 'ASC', sortOrder: 'ASC' },
    });
  }

  private buildGroupTree(groups: Group[], parentId: number | null = null): any[] {
    return groups
      .filter(g => (parentId === null ? !g.parentId : g.parentId === parentId))
      .map(g => ({
        ...g,
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
    if (!parent) return { level: 0, parentPath: null, departmentId: null };

    return {
      level: (parent.level || 0) + 1,
      // 父组的完整 path（如 "1/3"），子组保存后拼接为 "1/3/7"
      parentPath: parent.path || null,
      departmentId: parent.departmentId,
    };
  }

  async createGroup(data: { name: string; description?: string; departmentId?: number; parentId?: number; leaderId?: number }) {
    const pathInfo = await this.computeGroupPath(data.parentId || null);

    // 如果没有指定部门但有父组，继承父组的部门
    const deptId = data.departmentId || pathInfo.departmentId || null;

    const groupData: any = {
      name: data.name,
      description: data.description,
      departmentId: deptId,
      parentId: data.parentId || null,
      level: pathInfo.level,
      // path 先留空，保存拿到自身 id 后再拼接
      path: '',
    };
    if (data.leaderId) groupData.leader = { id: data.leaderId };
    if (data.parentId) groupData.parent = { id: data.parentId };
    if (deptId) groupData.department = { id: deptId };

    const group = this.groupRepo.create(groupData);
    const saved = await this.groupRepo.save(group) as unknown as Group;

    // path = 父级 path + 自身 id（语义：从根到自身的完整 id 路径，如 "1/3/7"）
    saved.path = pathInfo.parentPath ? `${pathInfo.parentPath}/${saved.id}` : `${saved.id}`;
    return this.groupRepo.save(saved);
  }

  async updateGroup(id: number, data: { name?: string; description?: string; departmentId?: number; parentId?: number; leaderId?: number }) {
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const group = await txService.groupRepo.findOne({ where: { id } });
      if (!group) throw new BusinessError('分组不存在');

      // 防止循环引用
      if (data.parentId) {
        if (data.parentId === id) throw new BusinessError('不能将自己设为父级');
        let checkId: number | null = data.parentId;
        while (checkId) {
          if (checkId === id) throw new BusinessError('不能形成循环引用');
          const p = await txService.groupRepo.findOne({ where: { id: checkId } });
          checkId = p?.parentId ?? null;
        }
      }

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.leaderId !== undefined) updateData.leader = data.leaderId ? { id: data.leaderId } : null;
      if (data.departmentId !== undefined) updateData.departmentId = data.departmentId || null;
      if (data.parentId !== undefined) {
        updateData.parentId = data.parentId || null;
        updateData.parent = data.parentId ? { id: data.parentId } : null;
        const pathInfo = await txService.computeGroupPath(data.parentId || null);
        updateData.level = pathInfo.level;
        await txService.groupRepo.save({ id, ...updateData });
        // 父级变更：重新计算自身及所有子组的 path（原子）
        await txService.repathGroup(id);
        return txService.groupRepo.findOne({ where: { id }, relations: ['leader', 'parent', 'department'] });
      }

      await txService.groupRepo.save({ id, ...updateData });
      return txService.groupRepo.findOne({ where: { id }, relations: ['leader', 'parent', 'department'] });
    });
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
    const childCount = await this.groupRepo.count({ where: { parentId: id } });
    if (childCount > 0) throw new BusinessError('该分组下还有子分组，无法删除');
    const userCount = await this.userRepo.count({ where: { group: { id } } });
    if (userCount > 0) throw new BusinessError('该分组下还有用户，无法删除');
    return this.groupRepo.delete(id);
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

    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const userData: any = {
        username: data.username,
        password: await bcrypt.hash(data.password, 10),
        realName: data.realName,
        email: data.email,
        phone: data.phone,
      };
      if (data.departmentId) userData.department = { id: data.departmentId };
      if (data.groupId) userData.group = { id: data.groupId };
      if (data.roleIds?.length) {
        userData.roles = await txService.roleRepo.findBy({ id: In(data.roleIds) });
      }

      const user = txService.userRepo.create(userData);
      return txService.userRepo.save(user);
    });
  }

  async updateUser(id: number, data: { realName?: string; email?: string; phone?: string; status?: number; departmentId?: number; groupId?: number; roleIds?: number[] }) {
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const updateData: any = { ...data };
      if (data.departmentId !== undefined) updateData.department = data.departmentId ? { id: data.departmentId } : null;
      if (data.groupId !== undefined) updateData.group = data.groupId ? { id: data.groupId } : null;
      if (data.roleIds) updateData.roles = await txService.roleRepo.findBy({ id: In(data.roleIds) });
      delete updateData.departmentId;
      delete updateData.groupId;
      delete updateData.roleIds;

      await txService.userRepo.save({ id, ...updateData });
      return txService.userRepo.findOne({ where: { id }, relations: ['department', 'group', 'roles'] });
    });
  }

  async deleteUser(id: number) {
    // 检查关联工时/加班/周报，避免硬删除导致历史数据断裂或外键报错
    const [timesheetCount, overtimeCount, weeklyCount] = await Promise.all([
      this.timesheetRepo.count({ where: { userId: id } }),
      this.overtimeRepo.count({ where: { userId: id } }),
      this.weeklyReportRepo.count({ where: { userId: id } }),
    ]);
    if (timesheetCount + overtimeCount + weeklyCount > 0) {
      throw new BusinessError('该用户存在工时/加班/周报记录，无法删除（建议改为禁用）');
    }
    return this.userRepo.delete(id);
  }

  async resetPassword(id: number, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BusinessError('用户不存在');
    user.password = await bcrypt.hash(newPassword, 10);
    return this.userRepo.save(user);
  }

  // ==================== 角色权限 ====================
  async getRoles() {
    return this.roleRepo.find({ relations: ['permissions'], order: { id: 'ASC' } });
  }

  async updateRolePermissions(roleId: number, permissionIds: number[]) {
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const role = await txService.roleRepo.findOne({ where: { id: roleId }, relations: ['permissions'] });
      if (!role) throw new BusinessError('角色不存在');
      role.permissions = await txService.permRepo.findBy({ id: In(permissionIds) });
      return txService.roleRepo.save(role);
    });
  }

  async getPermissions() {
    return this.permRepo.find({ order: { module: 'ASC', action: 'ASC' } });
  }

  async initPermissions() {
    for (const def of permissionDefinitions) {
      const existing = await this.permRepo.findOne({ where: { code: def.code } });
      if (!existing) {
        await this.permRepo.save(this.permRepo.create(def));
      } else {
        await this.permRepo.save({
          ...existing,
          name: def.name,
          module: def.module,
          action: def.action,
          grantable: !!def.grantable,
          scopeTypes: def.scopeTypes ?? null,
        });
      }
    }
    return this.permRepo.find();
  }

  // ==================== 项目管理 ====================
  async getProjects() {
    return this.projectRepo.find({
      relations: ['managers', 'moduleSEs', 'moduleSEs.user', 'moduleSEs.group'],
      order: { createdAt: 'DESC' },
    });
  }

  async createProject(data: { name: string; code: string; description?: string; managerIds?: number[] }) {
    const existing = await this.projectRepo.findOne({ where: { code: data.code } });
    if (existing) throw new BusinessError('项目编码已存在');
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const projectData: any = { name: data.name, code: data.code, description: data.description };
      if (data.managerIds?.length) {
        projectData.managers = await txService.userRepo.findBy({ id: In(data.managerIds) });
      } else {
        projectData.managers = [];
      }
      const project = txService.projectRepo.create(projectData);
      return txService.projectRepo.save(project);
    });
  }

  async updateProject(id: number, data: { name?: string; description?: string; status?: string; managerIds?: number[] }) {
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.managerIds !== undefined) {
        updateData.managers = data.managerIds.length
          ? await txService.userRepo.findBy({ id: In(data.managerIds) })
          : [];
      }
      await txService.projectRepo.save({ id, ...updateData });
      return txService.projectRepo.findOne({ where: { id }, relations: ['managers'] });
    });
  }

  async deleteProject(id: number) {
    // 检查关联工时/加班，避免删除后留下悬空 projectId
    const [timesheetCount, overtimeCount] = await Promise.all([
      this.timesheetRepo.count({ where: { projectId: id } }),
      this.overtimeRepo.count({ where: { projectId: id } }),
    ]);
    if (timesheetCount + overtimeCount > 0) {
      throw new BusinessError('该项目存在关联工时/加班记录，无法删除（建议改为停用）');
    }
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      await txService.projectSERepo.delete({ projectId: id });
      await txService.allocationRepo.delete({ projectId: id });
      return txService.projectRepo.delete(id);
    });
  }

  // ==================== 项目SE管理 ====================
  async getProjectSEs(projectId: number) {
    return this.projectSERepo.find({
      where: { projectId },
      relations: ['user', 'group'],
    });
  }

  async addProjectSE(data: { projectId: number; userId: number; groupId: number }) {
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const existing = await txService.projectSERepo.findOne({
        where: { projectId: data.projectId, groupId: data.groupId },
      });
      if (existing) {
        existing.userId = data.userId;
        const user = await txService.userRepo.findOne({ where: { id: data.userId } });
        existing.userName = user?.realName || '';
        return txService.projectSERepo.save(existing);
      }

      const user = await txService.userRepo.findOne({ where: { id: data.userId } });
      const group = await txService.groupRepo.findOne({ where: { id: data.groupId } });
      const se = txService.projectSERepo.create({
        ...data,
        userName: user?.realName || '',
        groupName: group?.name || '',
      });
      return txService.projectSERepo.save(se);
    });
  }

  async removeProjectSE(id: number) {
    return this.projectSERepo.delete(id);
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
    return AppDataSource.transaction(async (manager) => {
      const txService = new SystemService(manager);
      const existing = await txService.allocationRepo.findOne({
        where: { projectId: data.projectId, groupId: data.groupId },
      });
      if (existing) {
        existing.allocation = data.allocation;
        return txService.allocationRepo.save(existing);
      }
      const group = await txService.groupRepo.findOne({ where: { id: data.groupId } });
      const allocation = txService.allocationRepo.create({
        ...data,
        groupName: group?.name || '',
      });
      return txService.allocationRepo.save(allocation);
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
      .select('COALESCE(SUM(t.hours), 0)', 'total')
      .getRawOne();
    return Number(result?.total || 0);
  }

  /** 获取所有用户列表（供选择器用） */
  async getAllUsers() {
    return this.userRepo.find({
      where: { status: 1 },
      select: ['id', 'username', 'realName'],
      order: { realName: 'ASC' },
    });
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
    return this.projectRepo.find({
      where: { status: 'active' },
      order: { name: 'ASC' },
    });
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
