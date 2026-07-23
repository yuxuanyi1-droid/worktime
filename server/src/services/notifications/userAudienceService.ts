import { EntityManager, In, Like } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { Group } from '../../entities/Group';
import { Department } from '../../entities/Department';
import { User } from '../../entities/User';
import { BusinessError } from '../../utils/errors';

export type UserAudienceScope = 'all' | 'department' | 'group' | 'user';

export interface UserAudience {
  targetScope: UserAudienceScope;
  targetDeptId?: number | null;
  targetGroupId?: number | null;
  targetUserIds?: number[] | null;
}

/**
 * 统一解析组织范围内的启用用户。分组范围包含所选分组及其全部子分组。
 */
export class UserAudienceService {
  constructor(private manager?: EntityManager) {}

  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get departmentRepo() { return (this.manager ?? AppDataSource).getRepository(Department); }

  async resolveUserIds(audience: UserAudience, options: { strict?: boolean } = {}): Promise<number[]> {
    if (audience.targetScope === 'all') {
      const users = await this.userRepo.find({ select: { id: true }, where: { status: 1 } });
      return users.map(user => user.id);
    }

    if (audience.targetScope === 'department') {
      if (!audience.targetDeptId) throw new BusinessError('请选择目标部门');
      if (options.strict && !await this.departmentRepo.findOne({ where: { id: audience.targetDeptId } })) {
        throw new BusinessError('目标部门不存在');
      }
      const users = await this.userRepo.find({
        select: { id: true },
        where: { status: 1, department: { id: audience.targetDeptId } },
        relations: { department: true },
      });
      return users.map(user => user.id);
    }

    if (audience.targetScope === 'group') {
      if (!audience.targetGroupId) throw new BusinessError('请选择目标分组');
      const groupIds = await this.getGroupAndDescendantIds(audience.targetGroupId, options.strict ?? false);
      if (!groupIds.length) return [];
      const users = await this.userRepo.find({
        select: { id: true },
        where: { status: 1, group: { id: In(groupIds) } },
        relations: { group: true },
      });
      return users.map(user => user.id);
    }

    const targetUserIds = Array.from(new Set(audience.targetUserIds || []));
    if (!targetUserIds.length) throw new BusinessError('请选择目标用户');
    const users = await this.userRepo.find({
      select: { id: true },
      where: { status: 1, id: In(targetUserIds) },
    });
    if (options.strict && users.length !== targetUserIds.length) {
      throw new BusinessError('目标用户中包含不存在或已禁用的账号');
    }
    return users.map(user => user.id);
  }

  async getGroupAndDescendantIds(groupId: number, strict = true): Promise<number[]> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) {
      if (strict) throw new BusinessError('分组不存在');
      return [];
    }
    const path = group.path || String(group.id);
    const groups = await this.groupRepo.find({
      select: { id: true },
      where: [
        { id: group.id },
        { path: Like(`${path}/%`) },
      ],
    });
    return Array.from(new Set(groups.map(item => item.id)));
  }
}
