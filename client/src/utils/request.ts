import axios from 'axios';
import { message } from 'antd';
import { useAuthStore } from '../stores/authStore';

const request = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
});

// 请求拦截器 - 自动添加 Token
request.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    const { data } = response;
    if (data.code !== 0 && data.code !== undefined) {
      message.error(data.message || '请求失败');
      return Promise.reject(new Error(data.message));
    }
    return data;
  },
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clearAuth();
      // 通过事件总线通知 React 层软跳转（保留 SPA 状态，避免整页刷新丢数据）；
      // 已在登录页时不派发，避免循环
      if (window.location.pathname !== '/login') {
        window.dispatchEvent(new CustomEvent('unauthorized'));
      }
      // R9：标记已处理，调用方据此跳过 message.error，避免与跳转/弹框双重提示
      (error as any).__handled = true;
      return Promise.reject(error);
    }
    // 423 Locked：必须先修改初始密码。派发事件让 MainLayout 弹出强制改密框
    if (error.response?.status === 423) {
      window.dispatchEvent(new CustomEvent('must-change-password'));
      (error as any).__handled = true;
      return Promise.reject(error);
    }
    const msg = error.response?.data?.message || error.message || '网络错误';
    message.error(msg);
    return Promise.reject(error);
  }
);

export default request;

/**
 * 统一错误提示：从 axios error 提取后端 message，若已被拦截器标记 __handled（401/423 已弹框/跳转）则不重复提示。
 * 替代各页面重复的 getErrorMessage + message.error 组合。
 */
export function showError(error: unknown, fallback: string) {
  const e = error as { __handled?: boolean; response?: { data?: { message?: string } }; message?: string };
  if (e?.__handled) return; // 401/423 已由拦截器处理，跳过避免双重提示
  const msg = e?.response?.data?.message || e?.message || fallback;
  message.error(msg);
}

