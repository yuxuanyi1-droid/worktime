import { create } from 'zustand';
import { systemApi } from '../api/system';

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  // 系统设置
  systemName: string;
  settingsLoaded: boolean;
  loadSettings: () => Promise<void>;
  setSystemName: (name: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  systemName: 'WorkTime',
  settingsLoaded: false,
  loadSettings: async () => {
    if (get().settingsLoaded) return;
    try {
      const res = await systemApi.getSettings();
      if (res.data?.settings?.system_name) {
        set({ systemName: res.data.settings.system_name, settingsLoaded: true });
      } else {
        set({ settingsLoaded: true });
      }
    } catch {
      set({ settingsLoaded: true });
    }
  },
  setSystemName: (name: string) => set({ systemName: name }),
}));
