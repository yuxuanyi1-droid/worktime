import { useAuthStore } from '../stores/authStore';

const permissionImplications: Record<string, string[]> = {
  'report:view:all': ['report:view:self', 'report:view:group', 'report:view:department', 'report:view:project', 'report:view:overtime'],
  'project:view:all': ['project:view:managed'],
  'system:announcement:create': ['system:announcement:view'],
  'system:announcement:update': ['system:announcement:view'],
  'system:announcement:delete': ['system:announcement:view'],
  'permission_grant:manage': ['permission_request:view:all'],
};

function hasCode(permissions: string[], code: string) {
  return permissions.includes(code);
}

function expandHeldPermissions(permissions: string[]) {
  const expanded = new Set(permissions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const code of Array.from(expanded)) {
      for (const implied of permissionImplications[code] || []) {
        if (!expanded.has(implied)) {
          expanded.add(implied);
          changed = true;
        }
      }
    }
  }
  return Array.from(expanded);
}

/**
 * 权限判断 hook
 */
export function usePermission() {
  const user = useAuthStore((s) => s.user);
  const permissions = expandHeldPermissions(user?.permissions || []);
  const roleNames = user?.roles?.map((r) => r.name) || [];

  const isAdmin = roleNames.includes('admin');
  const isManager = roleNames.includes('manager');
  const isGroupLeader = roleNames.includes('group_leader');
  const canApprove = isAdmin || isManager || isGroupLeader;

  /** 判断是否拥有某个权限 */
  const hasPermission = (code: string): boolean => {
    if (isAdmin) return true;
    return hasCode(permissions, code);
  };

  /** 判断是否拥有任一权限 */
  const hasAnyPermission = (...codes: string[]): boolean => {
    if (isAdmin) return true;
    return codes.some((c) => hasCode(permissions, c));
  };

  /** 判断是否拥有全部权限 */
  const hasAllPermissions = (...codes: string[]): boolean => {
    if (isAdmin) return true;
    return codes.every((c) => hasCode(permissions, c));
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
