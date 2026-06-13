import { AccessPolicyService, AccessViewer, UserDataScopePermissions } from '../services/accessPolicyService';

const accessPolicy = new AccessPolicyService();

export async function getManagedDepartmentIds(userId: number) {
  return accessPolicy.getManagedDepartmentIds(userId);
}

export async function getGroupAndDescendantIds(rootIds: number[]) {
  return accessPolicy.getGroupAndDescendantIds(rootIds);
}

export async function getManagedGroupIds(userId: number) {
  return accessPolicy.getManagedGroupIds(userId);
}

export async function canAccessUserData(viewer: AccessViewer, targetUserId: number, permissions?: UserDataScopePermissions) {
  return accessPolicy.canAccessUserData(viewer, targetUserId, permissions);
}
