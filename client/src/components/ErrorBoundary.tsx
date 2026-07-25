import { Component, ReactNode } from 'react';
import { Result, Button } from 'antd';

interface Props {
  children: ReactNode;
  /** 是否页面级（影响重置按钮行为：true=回首页，false=尝试恢复当前页） */
  fullPage?: boolean;
}

interface State {
  hasError: boolean;
  error?: Error;
  /** 是否为懒加载 chunk / 动态 import 失败——这类错误只能整页重载恢复 */
  isChunkError?: boolean;
}

/**
 * 判断是否为懒加载 chunk / 动态 import 失败。
 * - webpack：error.name === 'ChunkLoadError'，message 形如 "Loading chunk 12 failed."
 * - Vite/原生 ESM：message 形如 "Failed to fetch dynamically imported module" /
 *   "Importing a module script failed" / "error loading dynamically imported module"
 */
function isChunkLoadError(error: Error | undefined): boolean {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message || '',
  );
}

/**
 * React 错误边界：捕获子树渲染期异常，避免整页白屏。
 * - 根级（main.tsx）：兜底所有未捕获异常，显示整页错误 + 回首页
 * - 页面级（MainLayout 的 Outlet 外）：单页崩溃不影响菜单/导航
 * - 懒加载 chunk 加载失败（部署后旧 chunk 失效等）：点击「重试」整页 reload 恢复
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, isChunkError: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 控制台留痕，便于排查；生产可接入上报
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    // chunk/动态 import 失败无法通过重新渲染恢复（旧模块已失效），必须整页重载。
    if (this.state.isChunkError) {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: undefined, isChunkError: false });
    if (this.props.fullPage) {
      // __BASE_URL__：根路径部署为 '/'，子路径部署为 '/worktime/'
      window.location.href = __BASE_URL__;
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <Result
        status="error"
        title="页面出错了"
        subTitle={this.state.error?.message || '发生未知错误，请稍后重试'}
        extra={[
          <Button key="retry" type="primary" onClick={this.handleReset}>
            {this.state.isChunkError ? '重新加载' : this.props.fullPage ? '返回首页' : '重试'}
          </Button>,
        ]}
        style={{ padding: 48 }}
      />
    );
  }
}
