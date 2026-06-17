import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-dom') || id.includes('react-router-dom') || id.includes(`${path.sep}react${path.sep}`)) {
            return 'react-vendor';
          }
          if (id.includes('@ant-design')) return 'antd-icons';
          if (id.includes(`${path.sep}antd${path.sep}`)) return 'antd';
          if (id.includes('echarts')) return 'charts';
          if (id.includes('dayjs')) return 'dayjs';
          if (id.includes('axios')) return 'network';
          if (id.includes('zustand')) return 'state';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
