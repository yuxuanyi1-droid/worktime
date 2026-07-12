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
}

/**
 * React 错误边界：捕获子树渲染期异常，避免整页白屏。
 * - 根级（main.tsx）：兜底所有未捕获异常，显示整页错误 + 回首页
 * - 页面级（MainLayout 的 Outlet 外）：单页崩溃不影响菜单/导航
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 控制台留痕，便于排查；生产可接入上报
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
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
            {this.props.fullPage ? '返回首页' : '重试'}
          </Button>,
        ]}
        style={{ padding: 48 }}
      />
    );
  }
}
