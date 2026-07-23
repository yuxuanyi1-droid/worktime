import request from '../utils/request';
import { LoginResult, UserInfo, OidcProviderInfo, OidcBinding, OidcBindResult } from '../types';

export const authApi = {
  login: (data: { username: string; password: string }) =>
    request.post<any, { code: number; data: LoginResult }>('/auth/login', data),

  logout: () =>
    request.post<any, { code: number }>('/auth/logout'),

  getProfile: () =>
    request.get<any, { code: number; data: UserInfo }>('/auth/profile'),

  updateProfile: (data: { realName: string; email?: string; phone?: string }) =>
    request.put<any, { code: number; data: UserInfo }>('/auth/profile', data),

  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    request.put<any, { code: number }>('/auth/change-password', data),

  // ========== OIDC / 第三方登录 ==========
  /** 列出对用户可见的 OIDC 提供商（公开，登录页用） */
  oidcVisibleProviders: () =>
    request.get<any, { code: number; data: OidcProviderInfo[] }>('/auth/oidc/providers'),

  /** 发起 OIDC 授权（返回 IdP 授权页 URL，前端整页跳转过去） */
  oidcLogin: (
    provider: string,
    params?: { mode?: 'login' | 'bind'; redirect?: string; redirectUriBase?: string }
  ) =>
    request.get<any, { code: number; data: { url: string } }>(
      `/auth/oidc/${encodeURIComponent(provider)}/login`,
      { params }
    ),

  /** 回调：用 code+state 换本地 token（登录模式）或完成绑定（绑定模式） */
  oidcCallback: (
    provider: string,
    data: { code: string; state: string; redirectUriBase?: string }
  ) =>
    request.post<any, { code: number; data: LoginResult | OidcBindResult }>(
      `/auth/oidc/${encodeURIComponent(provider)}/callback`,
      data
    ),

  /** 列出当前用户的第三方账号绑定（个人中心用） */
  oidcBindings: () =>
    request.get<any, { code: number; data: OidcBinding[] }>('/auth/oidc/bindings'),

  /** 解绑指定 provider */
  oidcUnbind: (provider: string) =>
    request.delete<any, { code: number }>(`/auth/oidc/bindings/${encodeURIComponent(provider)}`),
};
