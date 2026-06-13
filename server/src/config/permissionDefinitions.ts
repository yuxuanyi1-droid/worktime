export type PermissionDefinition = {
  code: string;
  name: string;
  module: string;
  action: string;
  grantable?: boolean;
  scopeTypes?: string[];
};

const selfScopes = ['self'];
const managedScopes = ['group', 'department', 'project', 'global'];

export const permissionDefinitions: PermissionDefinition[] = [
  { code: 'timesheet:access', name: '工时管理-进入', module: 'timesheet', action: 'access' },
  { code: 'timesheet:create', name: '工时管理-新增', module: 'timesheet', action: 'create' },
  { code: 'timesheet:update:self', name: '工时管理-编辑自己的工时', module: 'timesheet', action: 'update:self' },
  { code: 'timesheet:delete:self', name: '工时管理-删除自己的草稿', module: 'timesheet', action: 'delete:self' },
  { code: 'timesheet:submit:self', name: '工时管理-提交自己的工时', module: 'timesheet', action: 'submit:self' },
  { code: 'timesheet:withdraw:self', name: '工时管理-撤回自己的工时', module: 'timesheet', action: 'withdraw:self' },
  { code: 'timesheet:view:self', name: '工时管理-查看自己的工时', module: 'timesheet', action: 'view:self', scopeTypes: selfScopes },
  { code: 'timesheet:view:group', name: '工时管理-查看组内工时', module: 'timesheet', action: 'view:group', grantable: true, scopeTypes: ['group'] },
  { code: 'timesheet:view:department', name: '工时管理-查看部门工时', module: 'timesheet', action: 'view:department', grantable: true, scopeTypes: ['department'] },
  { code: 'timesheet:view:project', name: '工时管理-查看项目工时', module: 'timesheet', action: 'view:project', grantable: true, scopeTypes: ['project'] },
  { code: 'timesheet:approve:assigned', name: '工时管理-审批分配给我的工时', module: 'timesheet', action: 'approve:assigned' },
  { code: 'timesheet:export', name: '工时管理-导出', module: 'timesheet', action: 'export', grantable: true, scopeTypes: managedScopes },

  { code: 'overtime:access', name: '加班管理-进入', module: 'overtime', action: 'access' },
  { code: 'overtime:create', name: '加班管理-新增', module: 'overtime', action: 'create' },
  { code: 'overtime:update:self', name: '加班管理-编辑自己的加班', module: 'overtime', action: 'update:self' },
  { code: 'overtime:delete:self', name: '加班管理-删除自己的草稿', module: 'overtime', action: 'delete:self' },
  { code: 'overtime:submit:self', name: '加班管理-提交自己的加班', module: 'overtime', action: 'submit:self' },
  { code: 'overtime:withdraw:self', name: '加班管理-撤回自己的加班', module: 'overtime', action: 'withdraw:self' },
  { code: 'overtime:view:self', name: '加班管理-查看自己的加班', module: 'overtime', action: 'view:self', scopeTypes: selfScopes },
  { code: 'overtime:view:group', name: '加班管理-查看组内加班', module: 'overtime', action: 'view:group', grantable: true, scopeTypes: ['group'] },
  { code: 'overtime:view:department', name: '加班管理-查看部门加班', module: 'overtime', action: 'view:department', grantable: true, scopeTypes: ['department'] },
  { code: 'overtime:approve:assigned', name: '加班管理-审批分配给我的加班', module: 'overtime', action: 'approve:assigned' },
  { code: 'overtime:export', name: '加班管理-导出', module: 'overtime', action: 'export', grantable: true, scopeTypes: managedScopes },

  { code: 'weekly_report:access', name: '周报管理-进入', module: 'weekly_report', action: 'access' },
  { code: 'weekly_report:create', name: '周报管理-新增', module: 'weekly_report', action: 'create' },
  { code: 'weekly_report:update:self', name: '周报管理-编辑自己的周报', module: 'weekly_report', action: 'update:self' },
  { code: 'weekly_report:submit:self', name: '周报管理-提交自己的周报', module: 'weekly_report', action: 'submit:self' },
  { code: 'weekly_report:view:self', name: '周报管理-查看自己的周报', module: 'weekly_report', action: 'view:self', scopeTypes: selfScopes },
  { code: 'weekly_report:view:group', name: '周报管理-查看组内周报', module: 'weekly_report', action: 'view:group', grantable: true, scopeTypes: ['group'] },
  { code: 'weekly_report:view:department', name: '周报管理-查看部门周报', module: 'weekly_report', action: 'view:department', grantable: true, scopeTypes: ['department'] },
  { code: 'weekly_report:approve:assigned', name: '周报管理-审批分配给我的周报', module: 'weekly_report', action: 'approve:assigned' },

  { code: 'approval:access', name: '审批中心-进入', module: 'approval', action: 'access' },
  { code: 'approval:view:todo', name: '审批中心-查看待审批', module: 'approval', action: 'view:todo' },
  { code: 'approval:view:done', name: '审批中心-查看已审批', module: 'approval', action: 'view:done' },
  { code: 'approval:view:cc', name: '审批中心-查看抄送', module: 'approval', action: 'view:cc' },
  { code: 'approval:view:all', name: '审批中心-查看全部', module: 'approval', action: 'view:all' },
  { code: 'approval:approve:assigned', name: '审批中心-审批分配给我的任务', module: 'approval', action: 'approve:assigned' },
  { code: 'approval:withdraw:self', name: '审批中心-撤回自己的申请', module: 'approval', action: 'withdraw:self' },

  { code: 'report:access', name: '报表中心-进入', module: 'report', action: 'access' },
  { code: 'report:view:self', name: '报表中心-个人报表', module: 'report', action: 'view:self', scopeTypes: selfScopes },
  { code: 'report:view:group', name: '报表中心-组别报表', module: 'report', action: 'view:group', grantable: true, scopeTypes: ['group'] },
  { code: 'report:view:department', name: '报表中心-部门报表', module: 'report', action: 'view:department', grantable: true, scopeTypes: ['department'] },
  { code: 'report:view:project', name: '报表中心-项目报表', module: 'report', action: 'view:project', grantable: true, scopeTypes: ['project'] },
  { code: 'report:view:all', name: '报表中心-全局报表', module: 'report', action: 'view:all', grantable: true, scopeTypes: ['global'] },
  { code: 'report:view:overtime', name: '报表中心-加班统计', module: 'report', action: 'view:overtime', grantable: true, scopeTypes: managedScopes },
  { code: 'report:export', name: '报表中心-导出', module: 'report', action: 'export', grantable: true, scopeTypes: managedScopes },

  { code: 'project:access', name: '项目管理-进入', module: 'project', action: 'access' },
  { code: 'project:view:self', name: '项目管理-查看参与项目', module: 'project', action: 'view:self' },
  { code: 'project:view:managed', name: '项目管理-查看负责项目', module: 'project', action: 'view:managed', grantable: true, scopeTypes: ['project'] },
  { code: 'project:view:all', name: '项目管理-查看全部项目', module: 'project', action: 'view:all', grantable: true, scopeTypes: ['global'] },
  { code: 'project:create', name: '项目管理-新增项目', module: 'project', action: 'create' },
  { code: 'project:update', name: '项目管理-编辑项目', module: 'project', action: 'update', grantable: true, scopeTypes: ['project', 'global'] },
  { code: 'project:delete', name: '项目管理-删除项目', module: 'project', action: 'delete' },
  { code: 'project:assign_manager', name: '项目管理-维护项目负责人', module: 'project', action: 'assign_manager' },
  { code: 'project:assign_se', name: '项目管理-维护模块SE', module: 'project', action: 'assign_se', grantable: true, scopeTypes: ['project'] },

  { code: 'system:access', name: '系统管理-进入', module: 'system', action: 'access' },
  { code: 'system:user:manage', name: '系统管理-用户管理', module: 'system', action: 'user:manage' },
  { code: 'system:role:manage', name: '系统管理-角色管理', module: 'system', action: 'role:manage' },
  { code: 'system:permission:manage', name: '系统管理-权限管理', module: 'system', action: 'permission:manage' },
  { code: 'system:org:manage', name: '系统管理-组织管理', module: 'system', action: 'org:manage' },
  { code: 'system:approval_flow:manage', name: '系统管理-审批流管理', module: 'system', action: 'approval_flow:manage' },
  { code: 'system:announcement:view', name: '系统管理-查看公告管理', module: 'system', action: 'announcement:view' },
  { code: 'system:announcement:create', name: '系统管理-发布公告', module: 'system', action: 'announcement:create' },
  { code: 'system:announcement:update', name: '系统管理-编辑公告', module: 'system', action: 'announcement:update' },
  { code: 'system:announcement:delete', name: '系统管理-删除公告', module: 'system', action: 'announcement:delete' },
  { code: 'system:audit:view', name: '系统管理-审计日志查看', module: 'system', action: 'audit:view' },
  { code: 'system:settings:manage', name: '系统管理-系统设置', module: 'system', action: 'settings:manage' },

  { code: 'permission_request:access', name: '权限申请-进入', module: 'permission_request', action: 'access' },
  { code: 'permission_request:create', name: '权限申请-提交申请', module: 'permission_request', action: 'create' },
  { code: 'permission_request:view:self', name: '权限申请-查看自己的申请', module: 'permission_request', action: 'view:self' },
  { code: 'permission_request:view:all', name: '权限申请-查看全部申请', module: 'permission_request', action: 'view:all' },
  { code: 'permission_request:approve:assigned', name: '权限申请-审批分配给我的申请', module: 'permission_request', action: 'approve:assigned' },
  { code: 'permission_grant:manage', name: '权限授权-管理授权', module: 'permission_grant', action: 'manage' },
];

export const permissionDefinitionMap = new Map(permissionDefinitions.map((definition) => [definition.code, definition]));

export const legacyPermissionAliases: Record<string, string[]> = {
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

export const permissionImplications: Record<string, string[]> = {
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

export function expandPermissionCodes(codes: Iterable<string>) {
  const expanded = new Set<string>();
  for (const code of codes) {
    expanded.add(code);
    for (const alias of legacyPermissionAliases[code] || []) {
      expanded.add(alias);
    }
  }

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

  for (const [legacyCode, aliases] of Object.entries(legacyPermissionAliases)) {
    if (aliases.some((alias) => expanded.has(alias))) {
      expanded.add(legacyCode);
    }
  }
  return expanded;
}
