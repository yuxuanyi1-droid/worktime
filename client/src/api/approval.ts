import request from '../utils/request';
import { PageResult, ApprovalItem, ApprovalRecord } from '../types';

export interface MySubmission {
  targetType: 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';
  targetId: number;
  instanceId?: number | null;
  title: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  currentStep?: number;
  totalSteps?: number;
  days?: number;
  date?: string;
  description?: string;
  permissionCode?: string;
  permissionName?: string;
  scopeType?: string;
  scopeId?: number | null;
  scopeName?: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

export interface ApprovalDetail {
  content: {
    targetType: string;
    targetId: number;
    instanceId?: number | null;
    status: string;
    currentStep: number;
    totalSteps: number;
    applicant: { id: number; name: string; department: string | null; group: string | null } | null;
    createdAt: string;
    updatedAt: string;
    date?: string;
    days?: number;
    description?: string;
    project?: { id: number; name: string } | null;
    overtimeType?: string;
    reason?: string;
    weekStart?: string;
    weekEnd?: string;
    totalDays?: number;
    content?: string;
    summary?: string;
    permissionCode?: string;
    permissionName?: string;
    scopeType?: string;
    scopeId?: number | null;
    scopeName?: string | null;
    expiresAt?: string | null;
    grantId?: number | null;
    submissionGroupId?: number;
    weekEntries?: { date: string; days: number }[];
    previousApproval?: { targetId: number; submissionGroupId: number } | null;
    /** 工时配额信息（timesheet 审批单动态计算，null=未配置配额=不限制） */
    quota?: {
      total: number;
      consumed: number;
      remaining: number;
      submitted: number;
      exceeded: boolean;
      groupName?: string;
    } | null;
  };
  flowSteps: {
    stepOrder: number;
    stepType: string;
    label: string;
    approverIds: number[];
    approverNames: string[];
    approverName: string | null;
    status: 'pending' | 'current' | 'approved' | 'rejected' | 'skipped' | 'withdrawn';
    action: string | null;
    comment: string | null;
    approvedAt: string | null;
    requireAllApprovers?: boolean;
    approverStatuses?: {
      id: number;
      name: string;
      status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped' | 'withdrawn';
      action: string | null;
      comment: string | null;
      actedAt: string | null;
    }[];
  }[];
  records: {
    stepOrder: number;
    stepType: string;
    stepLabel: string;
    approverId: number;
    approverName: string;
    action: string;
    comment: string | null;
    createdAt: string;
  }[];
  viewerContext?: {
    isApplicant: boolean;
    isCurrentApprover: boolean;
    isAdmin: boolean;
    isCcRecipient: boolean;
  };
}

export const approvalApi = {
  getPending: (params: any) => request.get<any, { code: number; data: PageResult<ApprovalItem> }>('/approvals/pending', { params }),
  approve: (items: { targetType: string; targetId: number; action: 'approve' | 'reject'; comment?: string }[]) =>
    request.post<any, { code: number }>('/approvals/approve', { items }),
  getHistory: (params: any) => request.get<any, { code: number; data: PageResult<ApprovalRecord> }>('/approvals/history', { params }),
  getMySubmissions: (params: any) => request.get<any, { code: number; data: PageResult<MySubmission> }>('/approvals/my-submissions', { params }),
  getDetail: (targetType: string, targetId: number) =>
    request.get<any, { code: number; data: ApprovalDetail }>(`/approvals/detail/${targetType}/${targetId}`),
  withdraw: (targetType: string, targetId: number) =>
    request.post<any, { code: number }>('/approvals/withdraw', { targetType, targetId }),
  cc: (targetType: string, targetId: number, recipientIds: number[]) =>
    request.post<any, { code: number }>('/approvals/cc', { targetType, targetId, recipientIds }),
  getUsers: () => request.get<any, { code: number; data: { id: number; realName: string; department: string | null }[] }>('/approvals/users'),
  getMyCc: (params?: any) => request.get<any, { code: number; data: PageResult<any> }>('/approvals/my-cc', { params }),
};
