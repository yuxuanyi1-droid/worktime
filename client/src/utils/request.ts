import axios from 'axios';
import { message } from 'antd';
import { useAuthStore } from '../stores/authStore';

const request = axios.create({
  // 子路径部署时 __BASE_PATH__ 形如 '/worktime'，baseURL 变 '/worktime/api/v1'；
  // 根路径部署时 __BASE_PATH__ 为空，baseURL 仍是 '/api/v1'。
  baseURL: `${__BASE_PATH__}/api/v1`,
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
      // 已在登录页或 OIDC 回调页时不派发，避免循环：
      //   - /login：登录页本身
      //   - /oidc/callback：第三方登录回调换 token 时若遇 401 不应抢跳
      // 子路径部署下 pathname 形如 /worktime/login，用 endsWith 兼容根路径与子路径两种部署。
      const pathname = window.location.pathname;
      if (!pathname.endsWith('/login') && !pathname.endsWith('/oidc/callback')) {
        window.dispatchEvent(new CustomEvent('unauthorized'));
      }
      return Promise.reject(error);
    }
    const msg = error.response?.data?.message || error.message || '网络错误';
    message.error(msg);
    return Promise.reject(error);
  }
);

export default request;

