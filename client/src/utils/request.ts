import axios, { type InternalAxiosRequestConfig } from 'axios';
import { message } from 'antd';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api/auth';

const request = axios.create({
  // 子路径部署时 __BASE_PATH__ 形如 '/worktime'，baseURL 变 '/worktime/api/v1'；
  // 根路径部署时 __BASE_PATH__ 为空，baseURL 仍是 '/api/v1'。
  baseURL: `${__BASE_PATH__}/api/v1`,
  timeout: 30000,
});

// 模块级最近错误去重：全局响应拦截器与页面层 catch 都可能对同一错误调用 message.error，
// 导致每个错误弹出两个 toast。用「相同消息 + 时间窗」去重，让后触发的那次（通常是页面层）
// 被吞掉，从而整页只弹一次。401 清态登出逻辑不受影响。
let lastErrorMessage = '';
let lastErrorAt = 0;
const ERROR_DEDUP_MS = 2000;

function notifyErrorOnce(msg: string) {
  const now = Date.now();
  if (msg === lastErrorMessage && now - lastErrorAt < ERROR_DEDUP_MS) {
    return; // 短时间内同一消息已弹过（多半是页面层已自行处理），跳过避免重复 toast
  }
  lastErrorMessage = msg;
  lastErrorAt = now;
  message.error(msg);
}

// 请求拦截器 - 自动添加 Token
request.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ==================== 401 静默刷新（access token 续期） ====================
//
// 后端登录返回 refreshToken；POST /auth/refresh 用它换新的 access token。
// 这里在响应拦截器里做「静默刷新 + 挂起请求重放」：
//   - 并发多个 401 时，只触发一次 refresh（isRefreshing 闸门），其余请求入队 pendingQueue，
//     刷新成功后用新 token 重放并 resolve；失败则全部 reject 并走清态登出。
//   - /auth/login 与 /auth/refresh 自身的 401 不重试（避免递归），直接走清态登出。
//   - 无 refreshToken（旧会话）维持原有 401 清态登出行为，向后兼容。
let isRefreshing = false;
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  config: InternalAxiosRequestConfig;
}
let pendingQueue: PendingRequest[] = [];

/** 已在登录页/OIDC 回调页时不派发 'unauthorized'（避免循环跳转），与原逻辑一致。 */
function shouldDispatchUnauthorized(): boolean {
  const pathname = window.location.pathname;
  return !pathname.endsWith('/login') && !pathname.endsWith('/oidc/callback');
}

/** 原有 401 清态登出：clearAuth + 派发 'unauthorized'（带页面守卫）+ reject。 */
function forceLogoutAndReject(error: unknown): Promise<never> {
  useAuthStore.getState().clearAuth();
  if (shouldDispatchUnauthorized()) {
    window.dispatchEvent(new CustomEvent('unauthorized'));
  }
  return Promise.reject(error);
}

/**
 * 用 refresh token 续期并重放原请求（及队列里挂起的所有请求）。
 * 仅在「有 refreshToken 且非 auth 端点 401」时由响应拦截器调用。
 */
async function handle401WithRefresh(error: any): Promise<unknown> {
  const originalConfig: InternalAxiosRequestConfig = error.config;

  // 防御：同一请求重试后再次 401 不再二次刷新，直接登出（避免极端情况下的死循环）。
  if (originalConfig?._retried) {
    return forceLogoutAndReject(error);
  }

  const refreshToken = useAuthStore.getState().refreshToken;
  // 无 refresh token（旧会话）→ 维持原有清态登出
  if (!refreshToken) {
    return forceLogoutAndReject(error);
  }

  // 已有刷新在进行：把本次请求挂入队列，等刷新结果
  if (isRefreshing) {
    return new Promise((resolve, reject) => {
      pendingQueue.push({ resolve, reject, config: originalConfig });
    });
  }

  // 发起刷新
  isRefreshing = true;
  try {
    const res = await authApi.refresh(refreshToken);
    const newToken = res.data.token;
    // 用新 access token 更新 store（保留 user 与现有 refreshToken，不丢登录态）
    const cur = useAuthStore.getState();
    if (!cur.user) {
      // 极端情况：user 已丢失，无法续态，直接登出
      return forceLogoutAndReject(error);
    }
    cur.setAuth(newToken, cur.user, cur.refreshToken);

    // 重放原请求（标记已重试，防止再次 401 时无限刷新）
    originalConfig._retried = true;
    originalConfig.headers.Authorization = `Bearer ${newToken}`;
    const replay = request(originalConfig);

    // 重放队列里挂起的所有请求（同样标记 _retried 并显式覆盖 Authorization）
    const queue = pendingQueue;
    pendingQueue = [];
    queue.forEach((item) => {
      item.config._retried = true;
      item.config.headers.Authorization = `Bearer ${newToken}`;
      request(item.config).then(item.resolve).catch(item.reject);
    });

    return replay;
  } catch (refreshError) {
    // 刷新失败（refresh token 过期/版本不符/网络错误）：排空队列并清态登出。
    // /auth/refresh 自身的 401 在响应拦截器里已 reject-only（不重复 clearAuth/dispatch），
    // 清态登出统一由这里负责，避免双重处理。
    pendingQueue.forEach((item) => item.reject(refreshError));
    pendingQueue = [];
    return forceLogoutAndReject(error);
  } finally {
    isRefreshing = false;
  }
}

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    const { data } = response;
    if (data.code !== 0 && data.code !== undefined) {
      // 业务错误（HTTP 200 但 code !== 0）：不主动弹 toast，由页面层 catch 统一自呈现，
      // 避免与页面层 antd message.error 同时弹出造成双 toast（去重对差异化文案不可靠）。
      return Promise.reject(new Error(data.message));
    }
    return data;
  },
  (error) => {
    if (error.response?.status === 401) {
      const url = (error.config?.url || '') as string;
      // 登录接口自身的 401 = 凭据错误：维持原有清态登出（不重试 refresh）
      if (url.endsWith('/auth/login')) {
        return forceLogoutAndReject(error);
      }
      // 刷新接口自身的 401 = refresh token 失效：不重试，直接 reject，
      // 由发起 refresh 的流程（handle401WithRefresh 的 catch）统一清态登出，避免双重清理。
      if (url.endsWith('/auth/refresh')) {
        return Promise.reject(error);
      }
      // 其余接口 401：尝试静默刷新并重放（401 提示由 unauthorized 事件 / 登出流程负责）
      return handle401WithRefresh(error);
    }
    // 5xx：不主动弹 toast，由页面层自呈现（页面 catch 通常会读取 response.data.message）
    if (error.response && error.response.status >= 500) {
      return Promise.reject(error);
    }
    // responseType:'blob'（如报表导出）：响应体是 Blob 取不到 message，拦截器不弹 toast
    // 也不打 _notified 标记，交给页面 catch 解析 Blob 后自呈现真实中文错误。
    if (error.config?.responseType === 'blob') {
      return Promise.reject(error);
    }
    // 其余情况（4xx 业务错误、网络断开、超时）：保留拦截器统一提示。
    // 网络断开时页面层往往拿不到具体消息，需要这里兜底。
    // 弹 toast 后给 error 打 _notified 标记，页面层 catch 经 reportError 去重不再重复弹。
    const msg = error.response?.data?.message || error.message || '网络错误';
    notifyErrorOnce(msg);
    (error as any)._notified = true;
    return Promise.reject(error);
  }
);

export default request;

// 扩展 axios 配置类型：标记已因 401 重试过的请求，防止重放后再次 401 触发无限刷新。
declare module 'axios' {
  interface InternalAxiosRequestConfig {
    _retried?: boolean;
  }
}
