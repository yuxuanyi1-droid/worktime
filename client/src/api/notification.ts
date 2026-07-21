import request from '../utils/request';
import { PageResult } from '../types';

export const NOTIFICATION_READ_STATE_EVENT = 'notification-read-state-changed';

export function emitNotificationReadStateChanged() {
  window.dispatchEvent(new CustomEvent(NOTIFICATION_READ_STATE_EVENT));
}

export interface NotificationItem {
  id: number;
  userId: number;
  type: string;
  title: string;
  content: string | null;
  targetType: string | null;
  targetId: number | null;
  isRead: boolean;
  createdAt: string;
}

export const notificationApi = {
  getList: (params?: any) => request.get<any, { code: number; data: PageResult<NotificationItem> }>('/notifications', { params }),
  getUnreadCount: () => request.get<any, { code: number; data: { count: number } }>('/notifications/unread-count'),
  markAsRead: (ids: number[]) => request.put<any, { code: number }>('/notifications/read', { ids }),
  markAllAsRead: () => request.put<any, { code: number }>('/notifications/read-all'),
  delete: (id: number) => request.delete<any, { code: number }>(`/notifications/${id}`),
};

export interface AnnouncementItem {
  id: number;
  title: string;
  content: string | null;
  type: 'info' | 'important' | 'urgent';
  targetScope: 'all' | 'department' | 'group' | 'user';
  targetDeptId: number | null;
  targetGroupId: number | null;
  targetUserIds: number[] | null;
  createdById: number;
  createdByName: string;
  isRead: boolean;
  createdAt: string;
  ttStatus?: 'disabled' | 'skipped' | 'sent' | 'failed';
}

export interface AnnouncementStats {
  targetCount: number;
  readCount: number;
  unreadCount: number;
  readRate: number;
  readUsers: { userId: number; realName: string; readAt: string }[];
}

export const announcementApi = {
  // 管理端
  getAdminList: (params?: any) => request.get<any, { code: number; data: PageResult<AnnouncementItem> }>('/announcements/admin/list', { params }),
  create: (data: any) => request.post<any, { code: number; data: AnnouncementItem }>('/announcements/admin', data),
  update: (id: number, data: any) => request.put<any, { code: number; data: AnnouncementItem }>(`/announcements/admin/${id}`, data),
  delete: (id: number) => request.delete<any, { code: number }>(`/announcements/admin/${id}`),
  getStats: (id: number) => request.get<any, { code: number; data: AnnouncementStats }>(`/announcements/admin/${id}/stats`),

  // 用户端
  getMyList: (params?: any) => request.get<any, { code: number; data: PageResult<AnnouncementItem> }>('/announcements/my', { params }),
  getMyUnreadCount: () => request.get<any, { code: number; data: { count: number } }>('/announcements/my/unread-count'),
  markAsRead: (id: number) => request.put<any, { code: number }>(`/announcements/my/read/${id}`),
  markAllAsRead: () => request.put<any, { code: number }>('/announcements/my/read-all'),
};
