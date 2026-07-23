import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';

interface UseRequestOptions<T> {
  /** 是否在挂载时自动执行（默认 true） */
  immediate?: boolean;
  /** 初始数据 */
  initialData?: T;
  /** 失败时是否自动 message.error 弹窗（默认 true） */
  showError?: boolean;
  /** 自定义失败文案，默认取后端 message */
  errorMessage?: string;
}

interface UseRequestResult<T, P extends any[]> {
  data: T;
  loading: boolean;
  error: string | null;
  /** 重新执行（可传参） */
  run: (...args: P) => Promise<T | undefined>;
  /** 手动重置状态 */
  reset: () => void;
}

/**
 * 统一请求 hook：封装 loading / error / data / 重新加载。
 * 取代各页面手写 useState(loading/error) + try/catch 的重复模式。
 *
 * @param service 返回 Promise 的请求函数（通常是 api.xxx）
 * @param options 配置项
 *
 * @example
 *   const { data, loading, error, run } = useRequest(
 *     () => overtimeApi.getMy({ pageSize: 100 }),
 *     { initialData: { list: [], total: 0 } },
 *   );
 *   // 手动刷新：run()
 */
export function useRequest<T, P extends any[] = []>(
  service: (...args: P) => Promise<T>,
  options: UseRequestOptions<T> = {},
): UseRequestResult<T, P> {
  const { immediate = true, initialData, showError = true, errorMessage } = options;

  const [data, setData] = useState<T | undefined>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const run = useCallback(async (...args: P): Promise<T | undefined> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await service(...args);
      if (mountedRef.current && requestId === requestIdRef.current) setData(result);
      return result;
    } catch (e: any) {
      const msg = e?.response?.data?.message || errorMessage || e?.message || '请求失败';
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(msg);
        if (showError) message.error(msg);
      }
      return undefined;
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    }
  }, [service, showError, errorMessage]);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    setData(initialData);
    setLoading(false);
    setError(null);
  }, [initialData]);

  useEffect(() => {
    if (immediate) run(...([] as unknown as P));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immediate]);

  return {
    data: data as T,
    loading,
    error,
    run,
    reset,
  };
}
