import { describe, expect, it, vi } from 'vitest';
import { Group } from '@server/entities/Group';
import { Department } from '@server/entities/Department';
import { User } from '@server/entities/User';
import { UserAudienceService } from '@server/services/notifications/userAudienceService';

function createService(
  userRepo: Record<string, unknown>,
  groupRepo: Record<string, unknown> = {},
  departmentRepo: Record<string, unknown> = {},
) {
  const manager = {
    getRepository(entity: unknown) {
      if (entity === User) return userRepo;
      if (entity === Group) return groupRepo;
      if (entity === Department) return departmentRepo;
      throw new Error('测试访问了未配置的仓库');
    },
  };
  return new UserAudienceService(manager as any);
}

describe('UserAudienceService', () => {
  it('全员范围仅返回启用用户', async () => {
    const find = vi.fn().mockResolvedValue([{ id: 1 }, { id: 3 }]);
    await expect(createService({ find }).resolveUserIds({ targetScope: 'all' }))
      .resolves.toEqual([1, 3]);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 1 } }));
  });

  it('部门范围携带部门关系条件', async () => {
    const find = vi.fn().mockResolvedValue([{ id: 5 }]);
    await expect(createService({ find }).resolveUserIds({
      targetScope: 'department', targetDeptId: 8,
    })).resolves.toEqual([5]);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 1, department: { id: 8 } },
    }));
  });

  it('分组范围包含目标分组和所有后代分组', async () => {
    const userFind = vi.fn().mockResolvedValue([{ id: 9 }]);
    const groupFind = vi.fn().mockResolvedValue([{ id: 4 }, { id: 6 }, { id: 6 }]);
    const service = createService({ find: userFind }, {
      findOne: vi.fn().mockResolvedValue({ id: 4, path: '1/4' }),
      find: groupFind,
    });

    await expect(service.resolveUserIds({ targetScope: 'group', targetGroupId: 4 }))
      .resolves.toEqual([9]);
    expect(groupFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.arrayContaining([{ id: 4 }]),
    }));
    const groupCondition = userFind.mock.calls[0][0].where.group.id;
    expect(groupCondition.value).toEqual([4, 6]);
  });

  it('指定用户去重并由数据库过滤停用或不存在用户', async () => {
    const find = vi.fn().mockResolvedValue([{ id: 2 }]);
    await expect(createService({ find }).resolveUserIds({
      targetScope: 'user', targetUserIds: [2, 2, 99],
    })).resolves.toEqual([2]);
    expect(find.mock.calls[0][0].where.status).toBe(1);
    expect(find.mock.calls[0][0].where.id.value).toEqual([2, 99]);
  });

  it('管理端严格模式拒绝不存在的组织目标和被过滤的用户', async () => {
    const strictDepartment = createService(
      { find: vi.fn() },
      {},
      { findOne: vi.fn().mockResolvedValue(null) },
    );
    await expect(strictDepartment.resolveUserIds({
      targetScope: 'department', targetDeptId: 88,
    }, { strict: true })).rejects.toThrow('目标部门不存在');

    const strictUsers = createService({ find: vi.fn().mockResolvedValue([{ id: 2 }]) });
    await expect(strictUsers.resolveUserIds({
      targetScope: 'user', targetUserIds: [2, 99],
    }, { strict: true })).rejects.toThrow('包含不存在或已禁用');

    const missingGroup = createService({ find: vi.fn() }, { findOne: vi.fn().mockResolvedValue(null) });
    await expect(missingGroup.resolveUserIds({
      targetScope: 'group', targetGroupId: 77,
    })).resolves.toEqual([]);
    await expect(missingGroup.resolveUserIds({
      targetScope: 'group', targetGroupId: 77,
    }, { strict: true })).rejects.toThrow('分组不存在');
  });

  it('拒绝缺失范围参数和不存在的分组', async () => {
    const service = createService({ find: vi.fn() }, { findOne: vi.fn().mockResolvedValue(null) });
    await expect(service.resolveUserIds({ targetScope: 'department' })).rejects.toThrow('请选择目标部门');
    await expect(service.resolveUserIds({ targetScope: 'group' })).rejects.toThrow('请选择目标分组');
    await expect(service.resolveUserIds({ targetScope: 'user', targetUserIds: [] })).rejects.toThrow('请选择目标用户');
    await expect(service.getGroupAndDescendantIds(77)).rejects.toThrow('分组不存在');
  });
});
