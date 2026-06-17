import { create } from 'zustand';
import { UserInfo } from '../types';

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  setAuth: (token: string, user: UserInfo) => void;
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
    localStorage.removeItem('user');
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  user: getStoredUser(),

  setAuth: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user });
  },

  clearAuth: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null });
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
    if (e.key === 'token' || e.key === 'user') {
      const token = localStorage.getItem('token');
      const user = getStoredUser();
      useAuthStore.setState({ token, user });
    }
  });
}

