import { create } from 'zustand';
import { UserInfo } from '../types';
import request from '../utils/request';

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  setAuth: (token: string, user: UserInfo) => void;
  clearAuth: () => void;
  isLoggedIn: () => boolean;
  /** 从后端拉取最新 profile（含运行时通过 grant 授予的权限）并刷新本地快照。 */
  refreshUser: () => Promise<void>;
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

  refreshUser: async () => {
    const { token } = get();
    if (!token) return;
    try {
      const res = await request.get<any, { code: number; data: UserInfo }>('/auth/profile');
      if (res.code === 0 && res.data) {
        localStorage.setItem('user', JSON.stringify(res.data));
        set({ user: res.data });
      }
    } catch {
      // 刷新失败（如网络抖动）不阻断主流程，沿用旧快照即可。
    }
  },
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

