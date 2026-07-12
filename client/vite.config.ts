import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 端口配置统一从仓库根 .env 读取（单一真相源），自动联动前端 server.port 与代理目标。
// loadEnv(mode='', dir=仓库根, prefixes='') 读取无 VITE_ 前缀的根 .env 全部变量。
const rootDir = path.resolve(__dirname, '..');
const rootEnv = loadEnv('', rootDir, '');
const serverPort = rootEnv.PORT || '3000';
const clientPort = Number(rootEnv.CLIENT_PORT) || 5173;
// 高级覆盖：如需让代理指向其它地址（非本仓库后端），设置 VITE_API_PROXY_TARGET
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || `http://localhost:${serverPort}`;

// 子路径部署前缀（根 .env 的 BASE_PATH，如 /worktime）。
// 规范化：剥尾部斜杠；空 = 根路径部署。
// 前端在构建期通过 define 注入 __BASE_PATH__（无尾斜杠）与 __BASE_URL__（带尾斜杠），
// 供 axios baseURL、BrowserRouter basename、整页跳转、分享链接使用。
// 注意：base 是构建期固化的，子路径部署的前端必须用对应 BASE_PATH 单独构建一次。
const basePath = (() => {
  // 优先取进程环境变量 BASE_PATH（CI/命令行注入，如 BASE_PATH=/worktime vite build），
  // 回退到根 .env 的 BASE_PATH（文件配置）。loadEnv 不读进程 env，必须显式合并。
  const raw = (process.env.BASE_PATH || rootEnv.BASE_PATH || '').trim().replace(/\/+$/, '');
  return raw && raw.startsWith('/') ? raw : '';
})();
const baseUrl = (basePath || '') + '/';

export default defineConfig({
  // 静态资源基址：根路径部署为 '/'，子路径部署为 '/worktime/'
  base: baseUrl,
  // 构建期常量注入：__BASE_PATH__（如 '/worktime'，空时 ''）、__BASE_URL__（如 '/worktime/'，空时 '/'）
  define: {
    __BASE_PATH__: JSON.stringify(basePath),
    __BASE_URL__: JSON.stringify(baseUrl),
  },
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
    port: clientPort,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
