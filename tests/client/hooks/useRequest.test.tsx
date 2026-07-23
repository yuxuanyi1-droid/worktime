import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequest } from '@client/hooks/useRequest';

const messageError = vi.hoisted(() => vi.fn());

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return { ...actual, message: { ...actual.message, error: messageError } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useRequest', () => {
  beforeEach(() => messageError.mockReset());

  it('支持手动执行、传参和重置状态', async () => {
    const service = vi.fn(async (id: number) => ({ id }));
    const { result } = renderHook(() => useRequest(service, {
      immediate: false,
      initialData: { id: 0 },
    }));

    await act(async () => {
      await expect(result.current.run(7)).resolves.toEqual({ id: 7 });
    });
    expect(result.current).toMatchObject({ data: { id: 7 }, loading: false, error: null });

    act(() => result.current.reset());
    expect(result.current).toMatchObject({ data: { id: 0 }, loading: false, error: null });
  });

  it('只允许最后一次并发请求更新界面状态', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const service = vi.fn((id: number) => id === 1 ? first.promise : second.promise);
    const { result } = renderHook(() => useRequest(service, {
      immediate: false,
      initialData: '初始值',
    }));

    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.run(1);
      secondRun = result.current.run(2);
    });

    await act(async () => {
      first.resolve('旧结果');
      await firstRun;
    });
    expect(result.current.data).toBe('初始值');
    expect(result.current.loading).toBe(true);

    await act(async () => {
      second.resolve('新结果');
      await secondRun;
    });
    expect(result.current).toMatchObject({ data: '新结果', loading: false, error: null });
  });

  it('优先展示后端错误，并可关闭全局错误提示', async () => {
    const service = vi.fn(async () => {
      throw { response: { data: { message: '后端校验失败' } } };
    });
    const { result } = renderHook(() => useRequest(service, {
      immediate: false,
      initialData: null,
      showError: false,
      errorMessage: '自定义错误',
    }));

    await act(async () => { await result.current.run(); });

    expect(result.current.error).toBe('后端校验失败');
    expect(messageError).not.toHaveBeenCalled();
  });

  it('卸载后忽略未完成请求的结果与提示', async () => {
    const request = deferred<string>();
    const { result, unmount } = renderHook(() => useRequest(() => request.promise, {
      immediate: false,
      initialData: '',
    }));
    let running!: Promise<string | undefined>;
    act(() => { running = result.current.run(); });
    unmount();

    request.reject(new Error('过期错误'));
    await running;

    await waitFor(() => expect(messageError).not.toHaveBeenCalled());
  });
});
