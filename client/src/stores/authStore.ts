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

