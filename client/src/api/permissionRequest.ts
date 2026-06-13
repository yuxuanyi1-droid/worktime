import request from '../utils/request';
import { PageResult, Permission, PermissionRequestItem, UserPermissionGrant } from '../types';

export const permissionRequestApi = {
  getGrantablePermissions: () =>
    request.get<any, { code: number; data: Permission[] }>('/permission-requests/grantable-permissions'),
  getMyRequests: (params?: any) =>
    request.get<any, { code: number; data: PageResult<PermissionRequestItem> }>('/permission-requests/my', { params }),
  getAllRequests: (params?: any) =>
    request.get<any, { code: number; data: PageResult<PermissionRequestItem> }>('/permission-requests/all', { params }),
  create: (data: {
    permissionCode: string;
    scopeType: string;
    scopeId?: number | null;
    reason: string;
    expiresAt?: string | null;
  }) => request.post<any, { code: number; data: PermissionRequestItem }>('/permission-requests', data),
  withdraw: (id: number) =>
    request.post<any, { code: number; data: PermissionRequestItem }>(`/permission-requests/${id}/withdraw`),
  getGrants: (params?: any) =>
    request.get<any, { code: number; data: PageResult<UserPermissionGrant> }>('/permission-requests/grants', { params }),
  getUsers: () =>
    request.get<any, { code: number; data: { id: number; username: string; realName: string; department: string | null }[] }>('/permission-requests/users'),
  revokeGrant: (id: number, reason?: string) =>
    request.post<any, { code: number; data: UserPermissionGrant }>(`/permission-requests/grants/${id}/revoke`, { reason }),
};
