import { AppDataSource } from '../config/database';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { User } from '../entities/User';

const departmentRepo = () => AppDataSource.getRepository(Department);
const groupRepo = () => AppDataSource.getRepository(Group);
const userRepo = () => AppDataSource.getRepository(User);

export async function getManagedDepartmentIds(userId: number) {
  const departments = await departmentRepo().find({ where: { leaderId: userId } });
  return departments.map((department) => department.id);
}

export async function getGroupAndDescendantIds(rootIds: number[]) {
  if (!rootIds.length) return [];

  const allGroups = await groupRepo().find();
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

export async function getManagedGroupIds(userId: number) {
  const groups = await groupRepo().find({ where: { leaderId: userId } });
  return getGroupAndDescendantIds(groups.map((group) => group.id));
}

export async function canAccessUserData(viewer: { id: number; roles: string[] }, targetUserId: number) {
  if (targetUserId === viewer.id) return true;
  if (viewer.roles.includes('admin')) return true;

  const targetUser = await userRepo().findOne({ where: { id: targetUserId }, relations: ['department', 'group'] });
  const managedGroupIds = await getManagedGroupIds(viewer.id);
  if (targetUser?.group?.id && managedGroupIds.includes(targetUser.group.id)) return true;

  if (!targetUser?.department?.id) return false;
  const managedDepartmentIds = await getManagedDepartmentIds(viewer.id);
  return managedDepartmentIds.includes(targetUser.department.id);
}
