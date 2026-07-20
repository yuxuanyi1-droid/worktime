import { EntityManager, In, Like } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { Group } from '../../entities/Group';
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

  async resolveUserIds(audience: UserAudience): Promise<number[]> {
    if (audience.targetScope === 'all') {
      const users = await this.userRepo.find({ select: { id: true }, where: { status: 1 } });
      return users.map(user => user.id);
    }

    if (audience.targetScope === 'department') {
      if (!audience.targetDeptId) throw new BusinessError('请选择公告部门');
      const users = await this.userRepo.find({
        select: { id: true },
        where: { status: 1, department: { id: audience.targetDeptId } },
        relations: { department: true },
      });
      return users.map(user => user.id);
    }

    if (audience.targetScope === 'group') {
      if (!audience.targetGroupId) throw new BusinessError('请选择公告分组');
      const groupIds = await this.getGroupAndDescendantIds(audience.targetGroupId);
      const users = await this.userRepo.find({
        select: { id: true },
        where: { status: 1, group: { id: In(groupIds) } },
        relations: { group: true },
      });
      return users.map(user => user.id);
    }

    const targetUserIds = Array.from(new Set(audience.targetUserIds || []));
    if (!targetUserIds.length) throw new BusinessError('请选择公告用户');
    const users = await this.userRepo.find({
      select: { id: true },
      where: { status: 1, id: In(targetUserIds) },
    });
    return users.map(user => user.id);
  }

  async getGroupAndDescendantIds(groupId: number): Promise<number[]> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new BusinessError('分组不存在');
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
