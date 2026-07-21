import { useAuthStore } from '../stores/authStore';

const permissionAliases: Record<string, string[]> = {
  'timesheet:read': ['timesheet:access', 'timesheet:view:self'],
  'timesheet:update': ['timesheet:update:self'],
  'timesheet:delete': ['timesheet:delete:self'],
  'overtime:read': ['overtime:access', 'overtime:view:self'],
  'overtime:update': ['overtime:update:self'],
  'overtime:delete': ['overtime:delete:self'],
  'weekly_report:read': ['weekly_report:access', 'weekly_report:view:self'],
  'system:read': ['system:access'],
  'report:personal': ['report:view:self'],
  'report:group': ['report:view:group'],
  'report:department': ['report:view:department'],
  'report:project': ['report:view:project'],
  'report:overtime': ['report:view:overtime'],
};

const permissionImplications: Record<string, string[]> = {
  'timesheet:create': ['timesheet:access'],
  'timesheet:update:self': ['timesheet:access'],
  'timesheet:delete:self': ['timesheet:access'],
  'timesheet:submit:self': ['timesheet:access'],
  'timesheet:view:self': ['timesheet:access'],
  'timesheet:view:group': ['timesheet:access'],
  'timesheet:view:department': ['timesheet:access'],
  'overtime:create': ['overtime:access'],
  'overtime:update:self': ['overtime:access'],
  'overtime:delete:self': ['overtime:access'],
  'overtime:submit:self': ['overtime:access'],
  'overtime:view:self': ['overtime:access'],
  'overtime:view:group': ['overtime:access'],
  'overtime:view:department': ['overtime:access'],
  'weekly_report:create': ['weekly_report:access'],
  'weekly_report:submit:self': ['weekly_report:access'],
  'weekly_report:view:self': ['weekly_report:access'],
  'weekly_report:view:group': ['weekly_report:access'],
  'weekly_report:view:department': ['weekly_report:access'],
  'approval:view:todo': ['approval:access'],
  'approval:view:done': ['approval:access'],
  'approval:view:cc': ['approval:access'],
  'approval:approve:assigned': ['approval:access'],
  'approval:withdraw:self': ['approval:access'],
  'report:view:self': ['report:access'],
  'report:view:group': ['report:access'],
  'report:view:department': ['report:access'],
  'report:view:project': ['report:access'],
  'report:view:all': ['report:view:self', 'report:view:group', 'report:view:department', 'report:view:project', 'report:view:overtime'],
  'report:view:overtime': ['report:access'],
  'report:export': ['report:access'],
  'project:view:managed': ['project:access'],
  'project:view:all': ['project:access', 'project:view:managed'],
  'project:create': ['project:access'],
  'project:update': ['project:access'],
  'project:delete': ['project:access'],
  'project:assign_manager': ['project:access'],
  'project:assign_se': ['project:access'],
  'system:user:manage': ['system:access'],
  'system:role:manage': ['system:access'],
  'system:permission:manage': ['system:access'],
  'system:org:manage': ['system:access'],
  'system:approval_flow:manage': ['system:access'],
  'system:announcement:view': ['system:access'],
  'system:announcement:create': ['system:access', 'system:announcement:view'],
  'system:announcement:update': ['system:access', 'system:announcement:view'],
  'system:announcement:delete': ['system:access', 'system:announcement:view'],
  'system:audit:view': ['system:access'],
  'system:settings:manage': ['system:access'],
  'permission_request:create': ['permission_request:access'],
  'permission_request:view:self': ['permission_request:access'],
  'permission_request:view:all': ['permission_request:access'],
  'permission_grant:manage': ['permission_request:access', 'permission_request:view:all'],
};

function hasCode(permissions: string[], code: string) {
  if (permissions.includes(code)) return true;
  return (permissionAliases[code] || []).some((alias) => permissions.includes(alias));
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
