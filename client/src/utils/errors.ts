import { message } from 'antd';

/**
 * 从请求错误中提取可读消息，供页面层 catch 展示。
 * 优先取服务端返回的 response.data.message，其次取 err.message，最后回退 fallback。
 * 注意：responseType:'blob' 时（如报表导出），4xx 响应体是 Blob 而非 JSON，
 * 取不到 message，这里回退到 err.message / fallback（Blob 内容由页面按需解析）。
 */
export function getErrorMessage(err: unknown, fallback = '操作失败'): string {
  const e = err as { response?: { data?: unknown }; message?: string };
  const data = e?.response?.data;
  if (data instanceof Blob) {
    return e?.message || fallback;
  }
  const serverMessage = (data as { message?: string } | undefined)?.message;
  return serverMessage || e?.message || fallback;
}

/**
 * 统一弹出错误 toast，并与 request 拦截器去重：
 * 拦截器对 4xx/网络错误已弹过 toast 并给 error 打 _notified 标记，
 * 页面层 catch 再调用本函数时直接跳过，避免同一错误弹两条。
 * 5xx / 业务错误（code!==0）拦截器不弹，由这里负责展示。
 */
export function reportError(err: unknown, fallback?: string): void {
  if ((err as any)?._notified) return;
  message.error(getErrorMessage(err, fallback));
}
