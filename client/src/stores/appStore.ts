import { create } from 'zustand';
import { systemApi } from '../api/system';

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  // 系统设置
  systemName: string;
  settingsLoaded: boolean;
  settingsError: boolean;
  loadSettings: () => Promise<void>;
  setSystemName: (name: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  systemName: 'WorkTime',
  settingsLoaded: false,
  settingsError: false,
  loadSettings: async () => {
    if (get().settingsLoaded) return;
    try {
      const res = await systemApi.getSettings();
      if (res.data?.settings?.system_name) {
        set({ systemName: res.data.settings.system_name, settingsLoaded: true, settingsError: false });
      } else {
        set({ settingsLoaded: true, settingsError: false });
      }
    } catch {
      // 失败时不标记 loaded、记录 error 态，下次调用可重试，
      // 避免整会话静默回退到默认系统名 "WorkTime"。
      set({ settingsError: true });
    }
  },
  setSystemName: (name: string) => set({ systemName: name }),
}));
