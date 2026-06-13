import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Role } from '../entities/Role';
import { Permission } from '../entities/Permission';
import { Project } from '../entities/Project';
import { ProjectSE } from '../entities/ProjectSE';
import bcrypt from 'bcryptjs';
import { In } from 'typeorm';
import { permissionDefinitions } from '../config/permissionDefinitions';

export class SystemService {
  // ==================== 部门管理 ====================
  private deptRepo = AppDataSource.getRepository(Department);
  private groupRepo = AppDataSource.getRepository(Group);
  private userRepo = AppDataSource.getRepository(User);
  private roleRepo = AppDataSource.getRepository(Role);
  private permRepo = AppDataSource.getRepository(Permission);
  private projectRepo = AppDataSource.getRepository(Project);
  private projectSERepo = AppDataSource.getRepository(ProjectSE);

  // 部门
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
    if (userCount > 0) throw new Error('该部门下还有用户，无法删除');
    return this.deptRepo.delete(id);
  }

  // ==================== 分组管理（多层级树形） ====================

  /** 获取分组树 */
  async getGroupTree(departmentId?: number) {
    const where: any = {};
    if (departmentId) where.departmentId = departmentId;
    const allGroups = await this.groupRepo.find({
      where,
      relations: ['leader', 'parent', 'users'],
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
        members: (g.users || []).map(u => ({ id: u.id, realName: u.realName, username: u.username })),
        children: this.buildGroupTree(groups, g.id),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** 计算分组的层级路径 */
  private async computeGroupPath(parentId: number | null): Promise<{ level: number; path: string; departmentId: number | null }> {
    if (!parentId) return { level: 0, path: '', departmentId: null };

    const parent = await this.groupRepo.findOneBy({ id: parentId });
    if (!parent) return { level: 0, path: '', departmentId: null };

    return {
      level: (parent.level || 0) + 1,
      path: parent.path ? `${parent.path}/${parentId}` : `${parentId}`,
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
      path: pathInfo.path,
    };
    if (data.leaderId) groupData.leader = { id: data.leaderId };
    if (data.parentId) groupData.parent = { id: data.parentId };
    if (deptId) groupData.department = { id: deptId };

    const group = this.groupRepo.create(groupData);
    const saved = await this.groupRepo.save(group) as unknown as Group;

    // 更新 path（包含自身ID）
    if (!saved.path) {
      saved.path = `${saved.id}`;
    } else {
      saved.path = `${saved.path}`;
    }
    return this.groupRepo.save(saved);
  }

  async updateGroup(id: number, data: { name?: string; description?: string; departmentId?: number; parentId?: number; leaderId?: number }) {
    const group = await this.groupRepo.findOne({ where: { id } });
    if (!group) throw new Error('分组不存在');

    // 防止循环引用
    if (data.parentId) {
      if (data.parentId === id) throw new Error('不能将自己设为父级');
      let checkId: number | null = data.parentId;
      while (checkId) {
        if (checkId === id) throw new Error('不能形成循环引用');
        const p = await this.groupRepo.findOne({ where: { id: checkId } });
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
      const pathInfo = await this.computeGroupPath(data.parentId || null);
      updateData.level = pathInfo.level;
      updateData.path = pathInfo.path;
    }

    await this.groupRepo.save({ id, ...updateData });
    return this.groupRepo.findOne({ where: { id }, relations: ['leader', 'parent', 'department'] });
  }

  async deleteGroup(id: number) {
    // 检查子组
    const childCount = await this.groupRepo.count({ where: { parentId: id } });
    if (childCount > 0) throw new Error('该分组下还有子分组，无法删除');
    // 检查用户
    const userCount = await this.userRepo.count({ where: { group: { id } } });
    if (userCount > 0) throw new Error('该分组下还有用户，无法删除');
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
      qb.andWhere('(u.username LIKE :kw OR u.realName LIKE :kw OR u.email LIKE :kw)', { kw: `%${keyword}%` });
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
    if (existing) throw new Error('用户名已存在');

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
      userData.roles = await this.roleRepo.findBy({ id: In(data.roleIds) });
    }

    const user = this.userRepo.create(userData);
    return this.userRepo.save(user);
  }

  async updateUser(id: number, data: { realName?: string; email?: string; phone?: string; status?: number; departmentId?: number; groupId?: number; roleIds?: number[] }) {
    const updateData: any = { ...data };
    if (data.departmentId !== undefined) updateData.department = data.departmentId ? { id: data.departmentId } : null;
    if (data.groupId !== undefined) updateData.group = data.groupId ? { id: data.groupId } : null;
    if (data.roleIds) updateData.roles = await this.roleRepo.findBy({ id: In(data.roleIds) });
    delete updateData.departmentId;
    delete updateData.groupId;
    delete updateData.roleIds;

    await this.userRepo.save({ id, ...updateData });
    return this.userRepo.findOne({ where: { id }, relations: ['department', 'group', 'roles'] });
  }

  async deleteUser(id: number) {
    return this.userRepo.delete(id);
  }

  async resetPassword(id: number, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new Error('用户不存在');
    user.password = await bcrypt.hash(newPassword, 10);
    return this.userRepo.save(user);
  }

  // ==================== 角色权限 ====================
  async getRoles() {
    return this.roleRepo.find({ relations: ['permissions'], order: { id: 'ASC' } });
  }

  async updateRolePermissions(roleId: number, permissionIds: number[]) {
    const role = await this.roleRepo.findOne({ where: { id: roleId }, relations: ['permissions'] });
    if (!role) throw new Error('角色不存在');
    role.permissions = await this.permRepo.findBy({ id: In(permissionIds) });
    return this.roleRepo.save(role);
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
    if (existing) throw new Error('项目编码已存在');
    const projectData: any = { name: data.name, code: data.code, description: data.description };
    if (data.managerIds?.length) {
      projectData.managers = await this.userRepo.findBy({ id: In(data.managerIds) });
    } else {
      projectData.managers = [];
    }
    const project = this.projectRepo.create(projectData);
    return this.projectRepo.save(project);
  }

  async updateProject(id: number, data: { name?: string; description?: string; status?: string; managerIds?: number[] }) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.managerIds !== undefined) {
      updateData.managers = data.managerIds.length
        ? await this.userRepo.findBy({ id: In(data.managerIds) })
        : [];
    }
    await this.projectRepo.save({ id, ...updateData });
    return this.projectRepo.findOne({ where: { id }, relations: ['managers'] });
  }

  async deleteProject(id: number) {
    await this.projectSERepo.delete({ projectId: id });
    return this.projectRepo.delete(id);
  }

  // ==================== 项目SE管理 ====================
  async getProjectSEs(projectId: number) {
    return this.projectSERepo.find({
      where: { projectId },
      relations: ['user', 'group'],
    });
  }

  async addProjectSE(data: { projectId: number; userId: number; groupId: number }) {
    const existing = await this.projectSERepo.findOne({
      where: { projectId: data.projectId, groupId: data.groupId },
    });
    if (existing) {
      // 更新SE
      existing.userId = data.userId;
      const user = await this.userRepo.findOne({ where: { id: data.userId } });
      existing.userName = user?.realName || '';
      return this.projectSERepo.save(existing);
    }

    const user = await this.userRepo.findOne({ where: { id: data.userId } });
    const group = await this.groupRepo.findOne({ where: { id: data.groupId } });
    const se = this.projectSERepo.create({
      ...data,
      userName: user?.realName || '',
      groupName: group?.name || '',
    });
    return this.projectSERepo.save(se);
  }

  async removeProjectSE(id: number) {
    return this.projectSERepo.delete(id);
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

  /** 获取当前用户作为管理员负责的项目 */
  async getMyManagedProjects(userId: number) {
    const allProjects = await this.projectRepo.find({
      relations: ['managers', 'moduleSEs', 'moduleSEs.user', 'moduleSEs.group'],
      order: { createdAt: 'DESC' },
    });
    // 过滤出包含当前用户作为管理员的项目
    return allProjects.filter(p => p.managers?.some((m: any) => m.id === userId));
  }

  /** 检查用户是否是某个项目的管理员 */
  async isUserProjectManager(userId: number): Promise<boolean> {
    const allProjects = await this.projectRepo.find({ relations: ['managers'] });
    return allProjects.some(p => p.managers?.some((m: any) => m.id === userId));
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
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      relations: ['managers'],
    });
    if (!project) return false;
    return project.managers?.some((m: any) => m.id === userId) ?? false;
  }

  /** 获取单个项目SE记录 */
  async getProjectSEById(id: number) {
    return this.projectSERepo.findOne({ where: { id } });
  }
}
