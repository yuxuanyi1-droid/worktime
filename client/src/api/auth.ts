import request from '../utils/request';
import { LoginResult, UserInfo } from '../types';

export const authApi = {
  login: (data: { username: string; password: string }) =>
    request.post<any, { code: number; data: LoginResult }>('/auth/login', data),

  getProfile: () =>
    request.get<any, { code: number; data: UserInfo }>('/auth/profile'),

  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    request.put<any, { code: number }>('/auth/change-password', data),
};
