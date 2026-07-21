import request from '../utils/request';
import { PageResult } from '../types';

export interface AuditLogItem {
  id: number;
  userId: number | null;
  userName: string;
  action: string;
  target: string;
  targetId: number | null;
  detail: string | null;
  ip: string | null;
  createdAt: string;
}

export interface AuditLogQuery {
  page?: number;
  pageSize?: number;
  userId?: number;
  action?: string;
  target?: string;
  startDate?: string;
  endDate?: string;
}

export const auditApi = {
  getList: (params: AuditLogQuery) =>
    request.get<any, { code: number; data: PageResult<AuditLogItem> }>('/audit-logs', { params }),
};
