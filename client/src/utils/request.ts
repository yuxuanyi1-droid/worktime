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
      // 已在登录页时不要重定向，避免无限刷新
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }
    const msg = error.response?.data?.message || error.message || '网络错误';
    message.error(msg);
    return Promise.reject(error);
  }
);

export default request;

