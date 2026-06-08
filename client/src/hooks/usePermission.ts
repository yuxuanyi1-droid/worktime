import { useAuthStore } from '../stores/authStore';

/**
 * 权限判断 hook
 */
export function usePermission() {
  const user = useAuthStore((s) => s.user);
  const permissions = user?.permissions || [];
  const roleNames = user?.roles?.map((r) => r.name) || [];

  const isAdmin = roleNames.includes('admin');
  const isManager = roleNames.includes('manager');
  const isGroupLeader = roleNames.includes('group_leader');
  const canApprove = isAdmin || isManager || isGroupLeader;

  /** 判断是否拥有某个权限 */
  const hasPermission = (code: string): boolean => {
    if (isAdmin) return true;
    return permissions.includes(code);
  };

  /** 判断是否拥有任一权限 */
  const hasAnyPermission = (...codes: string[]): boolean => {
    if (isAdmin) return true;
    return codes.some((c) => permissions.includes(c));
  };

  /** 判断是否拥有全部权限 */
  const hasAllPermissions = (...codes: string[]): boolean => {
    if (isAdmin) return true;
    return codes.every((c) => permissions.includes(c));
  };

  /** 判断是否拥有某个角色 */
  const hasRole = (...roles: string[]): boolean => {
    if (isAdmin) return true;
    return roles.some((r) => roleNames.includes(r));
  };

  return {
    permissions,
    roleNames,
    isAdmin,
    isManager,
    isGroupLeader,
    canApprove,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
  };
}
