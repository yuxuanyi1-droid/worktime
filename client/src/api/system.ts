import request from '../utils/request';
import { Department, Group, Role, Permission, Project, ProjectSE, ProjectWorkloadAllocation, ApprovalFlow, PageResult } from '../types';

export interface UserListItem {
  id: number;
  username: string;
  realName: string;
  email?: string;
  phone?: string;
  status: number;
  department: { id: number; name: string } | null;
  group: { id: number; name: string } | null;
  roles: { id: number; name: string; label: string }[];
  createdAt: string;
}

export interface SimpleUser {
  id: number;
  username: string;
  realName: string;
  departmentId?: number | null;
  groupId?: number | null;
}

export interface TimesheetReminderConfig {
  enabled: boolean;
  weekdays: number[];
  time: string;
  targetScope: 'all' | 'department' | 'group' | 'user';
  targetDeptId?: number;
  targetGroupId?: number;
  targetUserIds?: number[];
  message: string;
}

export const systemApi = {
  // 部门
  getDepartments: () => request.get<any, { code: number; data: Department[] }>('/system/departments'),
  createDepartment: (data: any) => request.post<any, { code: number }>('/system/departments', data),
  updateDepartment: (id: number, data: any) => request.put<any, { code: number }>(`/system/departments/${id}`, data),
  deleteDepartment: (id: number) => request.delete<any, { code: number }>(`/system/departments/${id}`),

  // 分组（树形）
  getGroupTree: (departmentId?: number) => request.get<any, { code: number; data: Group[] }>('/system/groups/tree', { params: { departmentId } }),
  getGroups: (params?: any) => request.get<any, { code: number; data: Group[] }>('/system/groups', { params }),
  createGroup: (data: any) => request.post<any, { code: number }>('/system/groups', data),
  updateGroup: (id: number, data: any) => request.put<any, { code: number }>(`/system/groups/${id}`, data),
  deleteGroup: (id: number) => request.delete<any, { code: number }>(`/system/groups/${id}`),

  // 用户
  getUsers: (params: any) => request.get<any, { code: number; data: PageResult<UserListItem> }>('/system/users', { params }),
  getAllUsers: () => request.get<any, { code: number; data: SimpleUser[] }>('/system/users/all'),
  createUser: (data: any) => request.post<any, { code: number }>('/system/users', data),
  updateUser: (id: number, data: any) => request.put<any, { code: number }>(`/system/users/${id}`, data),
  deleteUser: (id: number) => request.delete<any, { code: number }>(`/system/users/${id}`),
  resetPassword: (id: number, password?: string) => request.put<any, { code: number; data?: { password: string } }>(`/system/users/${id}/reset-password`, password ? { password } : {}),

  // 角色
  getRoles: () => request.get<any, { code: number; data: Role[] }>('/system/roles'),
  createRole: (data: { name: string; label: string; description?: string; permissionIds: number[] }) =>
    request.post<any, { code: number; data: Role }>('/system/roles', data),
  updateRole: (roleId: number, data: { label?: string; description?: string }) =>
    request.put<any, { code: number; data: Role }>(`/system/roles/${roleId}`, data),
  deleteRole: (roleId: number) => request.delete<any, { code: number }>(`/system/roles/${roleId}`),
  updateRolePermissions: (roleId: number, permissionIds: number[]) => request.put<any, { code: number }>(`/system/roles/${roleId}/permissions`, { permissionIds }),

  // 权限
  getPermissions: () => request.get<any, { code: number; data: Permission[] }>('/system/permissions'),
  initPermissions: () => request.post<any, { code: number; data: Permission[] }>('/system/permissions/init'),

  // 项目
  getProjects: () => request.get<any, { code: number; data: Project[] }>('/system/projects'),
  getActiveProjects: () => request.get<any, { code: number; data: { id: number; name: string; code: string }[] }>('/system/projects/active'),
  getMyProjects: () => request.get<any, { code: number; data: Project[] }>('/system/projects/my'),
  canViewProjects: () => request.get<any, { code: number; data: { canView: boolean; isAdmin: boolean; isManager: boolean } }>('/system/projects/can-view'),
  createProject: (data: any) => request.post<any, { code: number }>('/system/projects', data),
  updateProject: (id: number, data: any) => request.put<any, { code: number }>(`/system/projects/${id}`, data),
  deleteProject: (id: number) => request.delete<any, { code: number }>(`/system/projects/${id}`),

  // 项目SE
  getProjectSEs: (projectId: number) => request.get<any, { code: number; data: ProjectSE[] }>(`/system/projects/${projectId}/ses`),
  addProjectSE: (projectId: number, data: { userId: number; groupId: number }) => request.post<any, { code: number }>(`/system/projects/${projectId}/ses`, data),
  removeProjectSE: (id: number) => request.delete<any, { code: number }>(`/system/projects/ses/${id}`),

  // 项目工时配额（按组配置，单位人/天）
  getProjectAllocations: (projectId: number) => request.get<any, { code: number; data: ProjectWorkloadAllocation[] }>(`/system/projects/${projectId}/allocations`),
  addProjectAllocation: (projectId: number, data: { groupId: number; allocation: number }) => request.post<any, { code: number }>(`/system/projects/${projectId}/allocations`, data),
  removeProjectAllocation: (id: number) => request.delete<any, { code: number }>(`/system/projects/allocations/${id}`),

  // 审批流程
  getApprovalFlows: (type?: string) => request.get<any, { code: number; data: ApprovalFlow[] }>('/system/approval-flows', { params: { type } }),
  getApprovalFlow: (id: number) => request.get<any, { code: number; data: ApprovalFlow }>(`/system/approval-flows/${id}`),
  createApprovalFlow: (data: any) => request.post<any, { code: number }>('/system/approval-flows', data),
  updateApprovalFlow: (id: number, data: any) => request.put<any, { code: number }>(`/system/approval-flows/${id}`, data),
  deleteApprovalFlow: (id: number) => request.delete<any, { code: number }>(`/system/approval-flows/${id}`),

  // 系统设置
  getSettings: () => request.get<any, { code: number; data: { list: any[]; settings: Record<string, string> } }>('/system/settings'),
  updateSetting: (key: string, value: string) => request.put<any, { code: number }>(`/system/settings/${key}`, { value }),
};
