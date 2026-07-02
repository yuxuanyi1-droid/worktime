import { create } from 'zustand';
import { useAuthStore } from '../stores/authStore';
import request from '../utils/request';

/**
 * 权限模型（蕴含关系 + 旧别名映射）的权威源在后端 `server/src/config/permissionDefinitions.ts`。
 * 本文件维护一份与后端保持同步的内置快照作为 fallback，保证首屏立即可用（不阻塞渲染等待接口）；
 * 登录后会从 `/auth/permission-model` 拉取后端权威数据覆盖内置快照，消除前后端运行时漂移。
 *
 * 维护规则：调整权限模型时优先改后端 permissionDefinitions.ts，同步更新下方内置快照。
 */
const BUILTIN_PERMISSION_ALIASES: Record<string, string[]> = {
  'timesheet:read': ['timesheet:access', 'timesheet:view:self'],
  'timesheet:update': ['timesheet:update:self'],
  'timesheet:delete': ['timesheet:delete:self'],
  'overtime:read': ['overtime:access', 'overtime:view:self'],
  'overtime:update': ['overtime:update:self'],
  'overtime:delete': ['overtime:delete:self'],
  'weekly_report:read': ['weekly_report:access', 'weekly_report:view:self'],
  'weekly_report:update': ['weekly_report:update:self'],
  'system:read': ['system:access'],
  'report:personal': ['report:view:self'],
  'report:group': ['report:view:group'],
  'report:department': ['report:view:department'],
  'report:project': ['report:view:project'],
  'report:overtime': ['report:view:overtime'],
};

const BUILTIN_PERMISSION_IMPLICATIONS: Record<string, string[]> = {
  'timesheet:create': ['timesheet:access'],
  'timesheet:update:self': ['timesheet:access'],
  'timesheet:delete:self': ['timesheet:access'],
  'timesheet:submit:self': ['timesheet:access'],
  'timesheet:withdraw:self': ['timesheet:access'],
  'timesheet:view:self': ['timesheet:access'],
  'timesheet:view:group': ['timesheet:access'],
  'timesheet:view:department': ['timesheet:access'],
  'timesheet:view:project': ['timesheet:access'],
  'timesheet:approve:assigned': ['timesheet:access'],
  'timesheet:export': ['timesheet:access'],
  'overtime:create': ['overtime:access'],
  'overtime:update:self': ['overtime:access'],
  'overtime:delete:self': ['overtime:access'],
  'overtime:submit:self': ['overtime:access'],
  'overtime:withdraw:self': ['overtime:access'],
  'overtime:view:self': ['overtime:access'],
  'overtime:view:group': ['overtime:access'],
  'overtime:view:department': ['overtime:access'],
  'overtime:approve:assigned': ['overtime:access'],
  'overtime:export': ['overtime:access'],
  'weekly_report:create': ['weekly_report:access'],
  'weekly_report:update:self': ['weekly_report:access'],
  'weekly_report:submit:self': ['weekly_report:access'],
  'weekly_report:view:self': ['weekly_report:access'],
  'weekly_report:view:group': ['weekly_report:access'],
  'weekly_report:view:department': ['weekly_report:access'],
  'weekly_report:approve:assigned': ['weekly_report:access'],
  'approval:view:todo': ['approval:access'],
  'approval:view:done': ['approval:access'],
  'approval:view:cc': ['approval:access'],
  'approval:view:all': ['approval:access'],
  'approval:approve:assigned': ['approval:access'],
  'approval:withdraw:self': ['approval:access'],
  'report:view:self': ['report:access'],
  'report:view:group': ['report:access'],
  'report:view:department': ['report:access'],
  'report:view:project': ['report:access'],
  'report:view:all': ['report:view:self', 'report:view:group', 'report:view:department', 'report:view:project', 'report:view:overtime'],
  'report:view:overtime': ['report:access'],
  'report:export': ['report:access'],
  'project:view:self': ['project:access'],
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
  'permission_request:approve:assigned': ['permission_request:access'],
  'permission_grant:manage': ['permission_request:access', 'permission_request:view:all'],
};

interface PermissionModelState {
  implications: Record<string, string[]>;
  aliases: Record<string, string[]>;
  /** 版本号：每次从后端加载成功后 +1，用于触发订阅组件重渲染。 */
  version: number;
}

const usePermissionModelStore = create<PermissionModelState>(() => ({
  implications: BUILTIN_PERMISSION_IMPLICATIONS,
  aliases: BUILTIN_PERMISSION_ALIASES,
  version: 0,
}));

let permissionModelLoading: Promise<void> | null = null;

/**
 * 从后端拉取权威权限模型覆盖内置快照。幂等——并发调用复用同一个 Promise。
 * 拉取失败时静默保留内置快照，不阻断 UI。
 */
export function loadPermissionModel(): Promise<void> {
  if (permissionModelLoading) return permissionModelLoading;
  if (!useAuthStore.getState().token) return Promise.resolve();
  permissionModelLoading = (async () => {
    try {
      const res = await request.get<any, { code: number; data: { implications: Record<string, string[]>; aliases: Record<string, string[]> } }>('/auth/permission-model');
      if (res.code === 0 && res.data) {
        usePermissionModelStore.setState((s) => ({
          implications: res.data.implications || s.implications,
          aliases: res.data.aliases || s.aliases,
          version: s.version + 1,
        }));
      }
    } catch {
      // 拉取失败沿用内置快照
    } finally {
      permissionModelLoading = null;
    }
  })();
  return permissionModelLoading;
}

function hasCode(permissions: string[], code: string, aliases: Record<string, string[]>) {
  if (permissions.includes(code)) return true;
  return (aliases[code] || []).some((alias) => permissions.includes(alias));
}

function expandHeldPermissions(permissions: string[], implications: Record<string, string[]>) {
  const expanded = new Set(permissions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const code of Array.from(expanded)) {
      for (const implied of implications[code] || []) {
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
 * 权限判断 hook。
 * 订阅权限模型版本号，确保后端模型加载完成后使用该 hook 的组件会重渲染。
 */
export function usePermission() {
  const user = useAuthStore((s) => s.user);
  // 订阅 version 触发重渲染；模型本身从 getState 读取避免每次创建新引用
  usePermissionModelStore((s) => s.version);
  const { implications, aliases } = usePermissionModelStore.getState();

  const permissions = expandHeldPermissions(user?.permissions || [], implications);
  const roleNames = user?.roles?.map((r) => r.name) || [];

  const isAdmin = roleNames.includes('admin');
  const isManager = roleNames.includes('manager');
  const isGroupLeader = roleNames.includes('group_leader');
  const canApprove = isAdmin || isManager || isGroupLeader;

  /** 判断是否拥有某个权限 */
  const hasPermission = (code: string): boolean => {
    if (isAdmin) return true;
    return hasCode(permissions, code, aliases);
  };

  /** 判断是否拥有任一权限 */
  const hasAnyPermission = (...codes: string[]): boolean => {
    if (isAdmin) return true;
    return codes.some((c) => hasCode(permissions, c, aliases));
  };

  /** 判断是否拥有全部权限 */
  const hasAllPermissions = (...codes: string[]): boolean => {
    if (isAdmin) return true;
    return codes.every((c) => hasCode(permissions, c, aliases));
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
