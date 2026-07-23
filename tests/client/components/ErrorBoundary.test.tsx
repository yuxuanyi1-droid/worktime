import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@client/components/ErrorBoundary';

function Broken({ fail = true }: { fail?: boolean }) {
  if (fail) throw new Error('组件渲染失败');
  return <div>恢复成功</div>;
}

describe('ErrorBoundary', () => {
  const preventExpectedRenderError = (event: ErrorEvent) => event.preventDefault();

  beforeEach(() => window.addEventListener('error', preventExpectedRenderError));
  afterEach(() => {
    window.removeEventListener('error', preventExpectedRenderError);
    vi.restoreAllMocks();
  });

  it('正常渲染子组件', () => {
    render(<ErrorBoundary><div>页面内容</div></ErrorBoundary>);
    expect(screen.getByText('页面内容')).toBeInTheDocument();
  });

  it('捕获渲染异常、显示可理解错误并记录诊断信息', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);

    expect(screen.getByText('页面出错了')).toBeInTheDocument();
    expect(screen.getByText('组件渲染失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument();
    expect(error).toHaveBeenCalled();
  });

  it('页面级重试会重置边界状态并重新尝试渲染子树', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    function Recoverable() {
      if (fail) throw new Error('临时错误');
      return <div>恢复成功</div>;
    }
    const view = render(<ErrorBoundary><Recoverable /></ErrorBoundary>);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    view.rerender(<ErrorBoundary><Recoverable /></ErrorBoundary>);
    await waitFor(() => expect(screen.getByText('恢复成功')).toBeInTheDocument());
  });
});
