import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { AppDataSource } from '../config/database';
import { authConfig, oidcConfig } from '../config/auth';
import { User } from '../entities/User';
import { Role } from '../entities/Role';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { UserExternalIdentity } from '../entities/UserExternalIdentity';
import { AccessPolicyService } from './accessPolicyService';
import { BusinessError } from '../utils/errors';
import { logger } from '../utils/logger';

// 用户不存在时仍执行同成本的 bcrypt，避免通过响应耗时枚举有效用户名。
const DUMMY_PASSWORD_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
import { normalizeProviderUserInfo, type ProviderUserInfo } from './oidc/provider';
import { CacheKeys, CacheTtl, cacheSet, invalidateAuthUser, invalidateOrgSnapshot } from '../config/cache';
import { PERMISSION_MODEL_VERSION } from '../config/permissionDefinitions';
import { EntityManager } from 'typeorm';

export class AuthService {
  constructor(private manager?: EntityManager) {}

  private get source() { return this.manager ?? AppDataSource; }
  private get userRepo() { return this.source.getRepository(User); }
  private get roleRepo() { return this.source.getRepository(Role); }
  private get deptRepo() { return this.source.getRepository(Department); }
  private get groupRepo() { return this.source.getRepository(Group); }
  private get identityRepo() { return this.source.getRepository(UserExternalIdentity); }
  private get accessPolicy() { return new AccessPolicyService(this.manager); }

  /**
   * 签发本地 JWT（保留 tokenVersion，使 authMiddleware 的版本校验生效）。
   * SSO 登录和密码登录都走这里，保证下游 authMiddleware/permission 链路完全一致。
   */
  private signLocalJwt(user: User): string {
    return jwt.sign(
      { id: user.id, username: user.username, realName: user.realName, v: Number(user.tokenVersion) },
      authConfig.jwtSecret,
      { expiresIn: authConfig.jwtExpiresIn } as jwt.SignOptions
    );
  }

  /**
   * 组装登录响应（token + 含 permissions 的 user 对象）。
   * 供密码登录与 SSO 登录共用，避免重复代码。
   */
  private async buildLoginResponse(user: User, writeCache = true) {
    const token = this.signLocalJwt(user);
    const permissionSnapshot = await this.accessPolicy.getPermissionSnapshotForLoadedUser(user);
    const permissions = Array.from(permissionSnapshot.permissions);
    if (writeCache) {
      await cacheSet(CacheKeys.authUser(user.id), {
        id: user.id,
        username: user.username,
        realName: user.realName,
        roles: user.roles.map((role) => role.name),
        permissions,
        tokenVersion: Number(user.tokenVersion),
        permissionModelVersion: PERMISSION_MODEL_VERSION,
        permissionsRefreshAt: permissionSnapshot.refreshAt,
      }, CacheTtl.auth);
    }
    const idpManaged = await this.isIdpManaged(user.id);
    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        realName: user.realName,
        email: user.email,
        phone: user.phone,
        department: user.department ? { id: user.department.id, name: user.department.name } : null,
        group: user.group ? { id: user.group.id, name: user.group.name } : null,
        roles: user.roles.map(r => ({ id: r.id, name: r.name, label: r.label })),
        permissions,
        /** 档案是否由 IdP 管控（绑定了 JIT provider）——前端据此隐藏密码修改/信息编辑入口 */
        idpManaged,
      },
    };
  }

  /** 为内置 AI worker 签发短期 JWT，避免为了内部调用长期保存 PAT 明文。 */
  async issueAgentAccessToken(userId: number): Promise<string> {
    const user = await this.userRepo.findOne({ where: { id: userId, status: 1 } });
    if (!user) throw new BusinessError('用户不存在或已禁用', 401);
    return jwt.sign(
      { id: user.id, username: user.username, realName: user.realName, v: Number(user.tokenVersion), purpose: 'agent' },
      authConfig.jwtSecret,
      { expiresIn: '2h' } as jwt.SignOptions,
    );
  }

  /**
   * 判断用户是否绑定了任一 JIT provider——绑定则其档案（密码/姓名/邮箱/手机/部门）由 IdP 管控，
   * 本地不允许修改密码或编辑信息（避免本地改了又被下次 SSO 登录同步覆盖）。
   */
  private async isIdpManaged(userId: number): Promise<boolean> {
    // 只要绑定属于 JIT provider 就保持托管；enabled 仅控制是否允许发起新登录。
    const jitProviders = Object.entries(oidcConfig.providers)
      // 临时关闭登录入口不能把既有主身份源账号降级成本地可编辑账号。
      .filter(([, c]) => c.jit)
      .map(([name]) => name);
    if (jitProviders.length === 0) return false;
    const count = await this.identityRepo.count({
      where: jitProviders.map((p) => ({ provider: p, user: { id: userId } as User })),
    });
    return count > 0;
  }

  async login(username: string, password: string) {
    const user = await this.userRepo.findOne({
      where: { username, status: 1 },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });

    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      throw new BusinessError('用户名或密码错误');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new BusinessError('用户名或密码错误');
    }

    return this.buildLoginResponse(user);
  }

  /**
   * OIDC 第三方登录：按 (provider, subject) 查本地绑定，命中则签发本地 JWT。
   *
   * JIT 行为由 provider 配置的 jit 开关控制：
   * - jit=true（主要登录方式，如 Authentik）：未命中绑定时自动创建本地用户并绑定，
   *   且每次登录同步 IdP 侧最新部门/姓名/邮箱/手机（IdP 为组织架构单一事实来源）。
   * - jit=false/未设（补充登录方式，如钉钉）：未绑定时提示"请先账号密码登录后绑定"。
   *
   * 角色不在登录时自动同步——角色由本地管理员手动分配（IdP 的 groups 仅表示组织归属，不等同权限角色）。
   */
  async oidcLogin(provider: string, info: ProviderUserInfo) {
    const normalizedInfo = normalizeProviderUserInfo(info);
    if (this.manager) {
      const user = await this.resolveOidcUser(provider, normalizedInfo);
      // 事务内不提前写共享缓存；提交后的首次鉴权会按正常缓存未命中路径回源。
      return this.buildLoginResponse(user, false);
    }

    let userId: number;
    try {
      userId = await AppDataSource.transaction(async (manager) => {
        const user = await new AuthService(manager).resolveOidcUser(provider, normalizedInfo);
        return user.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // 两个首次回调并发时，其中一个可能已经完成 JIT 建号；唯一约束失败的一方重新查绑定即可。
      const concurrentIdentity = await this.identityRepo.findOne({
        where: { provider, subject: normalizedInfo.subject },
        relations: ['user'],
      });
      if (!concurrentIdentity?.user) {
        throw new BusinessError('第三方账号建号发生冲突，请稍后重试', 409);
      }
      userId = concurrentIdentity.user.id;
    }

    // 缓存和 JWT 必须在事务提交后生成，不能暴露尚未提交的用户/权限快照。
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });
    if (!user) throw new BusinessError('第三方登录用户查询失败', 500);
    return this.buildLoginResponse(user);
  }

  /** 在事务内完成建号、档案同步和身份展示字段更新。 */
  private async resolveOidcUser(provider: string, info: ProviderUserInfo): Promise<User> {
    const providerConfig = oidcConfig.providers[provider];
    const providerLabel = providerConfig?.label || provider;

    const identity = await this.identityRepo.findOne({
      where: { provider, subject: info.subject },
      relations: ['user', 'user.roles', 'user.roles.permissions', 'user.department', 'user.group'],
    });

    // 未命中绑定：根据 jit 开关决定是自动建号还是要求手动绑定
    if (!identity || !identity.user) {
      if (!providerConfig?.jit) {
        // 补充登录方式：提示手动绑定
        throw new BusinessError(
          `该${providerLabel}账号未绑定，请先用账号密码登录后在「个人信息」中绑定`,
          401
        );
      }
      // 主要登录方式：JIT 自动建号
      const newUser = await this.provisionUser(provider, info);
      logger.info(
        { provider, subject: info.subject, userId: newUser.id, username: newUser.username },
        'OIDC JIT 自动建号成功'
      );
      const freshUser = await this.userRepo.findOne({
        where: { id: newUser.id },
        relations: ['roles', 'roles.permissions', 'department', 'group'],
      });
      if (!freshUser) throw new BusinessError('JIT 建号后用户查询失败', 500);
      return freshUser;
    }

    const user = identity.user;
    if (user.status !== 1) {
      throw new BusinessError('账号已被禁用，请联系管理员', 401);
    }

    // JIT 用户每次登录同步 IdP 侧最新档案（部门/组归属 + 姓名/邮箱/手机），保证 IdP 为单一事实来源。
    // 角色不同步——由本地管理员手动维护。
    if (providerConfig?.jit) {
      await this.syncUserProfile(user, info);
    }
    // 所有 IdP 绑定都同步展示用户名和工号；TT 依赖 SIAM 返回的 employeeId。
    let identityChanged = false;
    if (info.username && identity.externalUsername !== info.username) {
      identity.externalUsername = info.username;
      identityChanged = true;
    }
    if (info.employeeId && identity.employeeId !== info.employeeId) {
      identity.employeeId = info.employeeId;
      identityChanged = true;
    }
    if (identityChanged) {
      await this.identityRepo.save(identity);
    }

    return user;
  }

  /**
   * JIT 自动建号：创建本地用户 + 写入第三方身份绑定 + 创建/复用部门组层级。
   * 用户名取 IdP 的 preferred_username；若与本地已存在用户冲突，追加 provider 前缀。
   * 部门/组按 IdP 的 department 路径（/ 分隔）自动创建层级树，用户挂最末端组。
   * 角色统一用 defaultRole（默认 employee），由本地管理员后续手动调整。
   */
  private async provisionUser(provider: string, info: ProviderUserInfo): Promise<User> {
    if (!this.manager) {
      return AppDataSource.transaction((manager) => new AuthService(manager).provisionUser(provider, info));
    }
    const providerConfig = oidcConfig.providers[provider]!;
    // 角色：JIT 统一用 defaultRole（默认 employee）。IdP groups 仅表示组织归属，不等同权限角色。
    const defaultRoleName = providerConfig.defaultRole || 'employee';
    const defaultRole = await this.roleRepo.findOne({ where: { name: defaultRoleName } });
    if (!defaultRole) {
      throw new BusinessError(`JIT 默认角色【${defaultRoleName}】不存在，请先在系统中创建`, 500);
    }
    const roles = [defaultRole];

    // 用户名：优先用 IdP preferred_username，冲突则追加 provider 前缀
    const fallbackUsername = `sso_${info.subject.slice(0, 8)}`;
    const usernameBase = (info.username?.trim() || fallbackUsername).slice(0, 50);
    let username = usernameBase;
    const existing = await this.userRepo.findOne({ where: { username } });
    if (existing) {
      const suffix = crypto.createHash('sha256')
        .update(`${provider}\0${info.subject}`)
        .digest('hex')
        .slice(0, 8);
      const prefixed = `${provider}_${usernameBase}`;
      username = `${prefixed.slice(0, 41)}_${suffix}`;
      const collision = await this.userRepo.findOne({ where: { username } });
      if (collision) throw new BusinessError('无法为第三方账号分配唯一用户名，请联系管理员', 409);
    }

    // 部门/组归属：按 IdP department 路径自动创建/复用 Department + Group 层级树
    const placement = await this.resolveOrgPlacement(info.department);

    // 创建用户（密码设为随机串——JIT 用户用密码登录无意义，但 password 非空约束需要值）
    const user = this.userRepo.create({
      username,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      realName: info.displayName || info.username || info.subject.slice(0, 8),
      email: info.email,
      phone: info.phone,
      department: placement?.department || undefined,
      group: placement?.group || undefined,
      roles,
      status: 1,
    });
    const saved = await this.userRepo.save(user);

    // 写入第三方身份绑定
    await this.identityRepo.save({
      provider,
      subject: info.subject,
      externalUsername: info.username || null,
      employeeId: info.employeeId || null,
      user: saved,
    } as UserExternalIdentity);

    return saved;
  }

  /**
   * JIT 用户每次登录同步 IdP 侧最新档案（IdP 为单一事实来源）。
   * 同步姓名/邮箱/手机/部门/组归属（IdP 调岗自动跟随），不同步角色（角色由本地管理员手动维护）。
   */
  private async syncUserProfile(user: User, info: ProviderUserInfo) {
    let changed = false;
    if (info.displayName && user.realName !== info.displayName) { user.realName = info.displayName; changed = true; }
    if (info.email && user.email !== info.email) { user.email = info.email; changed = true; }
    if (info.phone && user.phone !== info.phone) { user.phone = info.phone; changed = true; }
    // 同步部门/组归属
    const placement = await this.resolveOrgPlacement(info.department);
    if (placement) {
      if (placement.department && user.department?.id !== placement.department.id) {
        user.department = placement.department; changed = true;
      }
      if (placement.group && user.group?.id !== placement.group.id) {
        user.group = placement.group; changed = true;
      }
      // IdP 无组层级时清空 group（员工从子组调到无子组的部门）
      if (!placement.group && user.group) {
        user.group = null; changed = true;
      }
    } else if (info.department === '') {
      // 只有 IdP 明确返回空字符串时才清空；缺少 claim（undefined）可能是映射故障，不能破坏现有组织关系。
      if (user.department) { user.department = null; changed = true; }
      if (user.group) { user.group = null; changed = true; }
    }
    if (changed) await this.userRepo.save(user);
  }

  /**
   * 解析 IdP department 路径，创建/复用对应的 Department + Group 层级树。
   *
   * 路径格式（/ 分隔）：
   *   "手软部/蜂窝通信组/通话组"
   *     → Department=手软部, Group 层级: 蜂窝通信组(level0, 顶级组) → 通话组(level1, 子组), 用户挂通话组
   *   "手软部"
   *     → Department=手软部, 无 Group
   *   "" / undefined
   *     → 返回 null（无部门归属）
   *
   * Department/Group 按名称复用（不存在则创建），不删除既有结构，幂等可重复执行。
   * Group 的 path/level 语义与 seed.ts 一致：根到自身的 id 路径如 "5/12"，level 从 0 开始。
   *
   * @returns { department, group } —— group 为最末端组（无子组层时为 null）
   */
  private async resolveOrgPlacement(
    departmentPath?: string
  ): Promise<{ department: Department; group: Group | null } | null> {
    if (!departmentPath) return null;
    const segments = departmentPath.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    // 第一段 = Department
    const [deptName, ...groupNames] = segments;
    let department = await this.deptRepo.findOne({ where: { name: deptName } });
    if (!department) {
      department = this.deptRepo.create({ name: deptName });
      await this.deptRepo.save(department);
      logger.info({ department: deptName }, 'JIT 自动创建部门');
    }

    // 后续段 = Group 层级树（依次创建父子链）
    let group: Group | null = null;
    let parent: Group | null = null;
    for (let i = 0; i < groupNames.length; i++) {
      const gname = groupNames[i];
      const level = i; // 0=顶级组, 1=二级组...
      // 按名称 + 父级查找（同名组可能在不同层级下存在，需按父级区分）
      const existing: Group | null = parent
        ? await this.groupRepo.findOne({
            where: { name: gname, departmentId: department.id, parentId: parent.id },
          })
        : await this.groupRepo
            .createQueryBuilder('g')
            .where('g.name = :name', { name: gname })
            .andWhere('g.departmentId = :departmentId', { departmentId: department.id })
            .andWhere('g.parentId IS NULL')
            .getOne();
      if (existing) {
        group = existing;
        parent = existing;
        continue;
      }
      const parentPath = parent?.path || '';
      const newGroup: Group = this.groupRepo.create({
        name: gname,
        department,
        departmentId: department.id,
        parent: parent || undefined,
        parentId: parent?.id || null,
        level,
        path: parentPath, // 先占位，保存后补完整 path
      });
      await this.groupRepo.save(newGroup);
      // path = 父级 path + 自身 id（与 seed.ts 语义一致）
      newGroup.path = parentPath ? `${parentPath}/${newGroup.id}` : `${newGroup.id}`;
      await this.groupRepo.save(newGroup);
      logger.info({ group: gname, parentId: parent?.id, level }, 'JIT 自动创建分组');
      group = newGroup;
      parent = newGroup;
    }

    return { department, group };
  }

  async getProfile(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });

    if (!user) {
      throw new BusinessError('用户不存在');
    }

    const permissions = Array.from(await this.accessPolicy.getPermissionCodes(user.id));
    const idpManaged = await this.isIdpManaged(user.id);

    return {
      id: user.id,
      username: user.username,
      realName: user.realName,
      email: user.email,
      phone: user.phone,
      department: user.department ? { id: user.department.id, name: user.department.name } : null,
      group: user.group ? { id: user.group.id, name: user.group.name } : null,
      roles: user.roles.map(r => ({ id: r.id, name: r.name, label: r.label })),
      permissions,
      idpManaged,
    };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    if (await this.isIdpManaged(userId)) {
      throw new BusinessError('该账号由第三方身份源（SSO）管控，请在对应身份源中修改密码', 403);
    }
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BusinessError('用户不存在');

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) throw new BusinessError('原密码错误');

    user.password = await bcrypt.hash(newPassword, 10);
    // tokenVersion+1：使改密前签发的所有 token 失效，强制重新登录
    user.tokenVersion = Number(user.tokenVersion) + 1;
    await this.userRepo.save(user);
    await invalidateAuthUser(userId);
    return true;
  }

  /** 登出：使当前 token 失效（tokenVersion+1） */
  async logout(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BusinessError('用户不存在');
    user.tokenVersion = Number(user.tokenVersion) + 1;
    await this.userRepo.save(user);
    await invalidateAuthUser(userId);
  }

  async updateProfile(userId: number, data: { realName?: string; email?: string; phone?: string }) {
    if (await this.isIdpManaged(userId)) {
      throw new BusinessError('该账号由第三方身份源（SSO）管控，请在对应身份源中修改个人信息', 403);
    }
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BusinessError('用户不存在');

    if (data.realName) user.realName = data.realName;
    if (data.email !== undefined) user.email = data.email;
    if (data.phone !== undefined) user.phone = data.phone;

    await this.userRepo.save(user);
    await Promise.all([invalidateAuthUser(userId), invalidateOrgSnapshot(userId)]);
    return this.getProfile(userId);
  }
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { driverError?: { code?: string }; code?: string };
  return (candidate?.driverError?.code ?? candidate?.code) === '23505';
}
