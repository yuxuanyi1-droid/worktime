import { create } from 'zustand';
import { UserInfo } from '../types';

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: UserInfo | null;
  /**
   * 写入登录态。refreshToken 为可选：
   *  - 登录/SSO 回调传入新签发的 refreshToken → 一起持久化；
   *  - 个人信息更新、挂载时拉取 profile 等只更新 user 的场景不传 → 保留现有 refreshToken，避免被误清。
   */
  setAuth: (token: string, user: UserInfo, refreshToken?: string | null) => void;
  clearAuth: () => void;
  isLoggedIn: () => boolean;
}

function getStoredUser(): UserInfo | null {
  const raw = localStorage.getItem('user');
  if (!raw) return null;

  try {
    return JSON.parse(raw) as UserInfo;
  } catch {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  refreshToken: localStorage.getItem('refreshToken'),
  user: getStoredUser(),

  setAuth: (token, user, refreshToken) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    // 仅在显式传入 refreshToken 时更新；否则保留现有值（profile 更新等场景不应清掉它）
    const nextRefresh = typeof refreshToken === 'string' ? refreshToken : get().refreshToken;
    if (nextRefresh) {
      localStorage.setItem('refreshToken', nextRefresh);
    }
    set({ token, user, refreshToken: nextRefresh });
  },

  clearAuth: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    set({ token: null, refreshToken: null, user: null });
  },

  isLoggedIn: () => !!get().token,
}));

/**
 * 多 tab 状态同步：监听 localStorage 的 storage 事件。
 * 当 A tab 登录/登出/改密时，其它 tab 自动同步登录态，避免「A 登出 B 仍显示已登录」。
 * storage 事件只在「非当前 tab」的 localStorage 变更时触发，天然不会重复。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'token' || e.key === 'user' || e.key === 'refreshToken') {
      const token = localStorage.getItem('token');
      const user = getStoredUser();
      const refreshToken = localStorage.getItem('refreshToken');
      useAuthStore.setState({ token, user, refreshToken });
    }
  });
}

