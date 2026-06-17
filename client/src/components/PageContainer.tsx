import { ReactNode } from 'react';
import './PageContainer.css';

interface PageContainerProps {
  /** 页面标题 */
  title?: ReactNode;
  /** 右侧操作区（按钮等） */
  extra?: ReactNode;
  /** 页面主体内容 */
  children: ReactNode;
}

/**
 * 统一的页面容器：标题 + 操作区 + 内容区。
 * 取代各页面重复的 <Title> + <div style={{ padding }}> 模式，保证页面间距一致。
 *
 * @example
 *   <PageContainer title="加班管理" extra={<Button>新建</Button>}>
 *     <Table ... />
 *   </PageContainer>
 */
export function PageContainer({ title, extra, children }: PageContainerProps) {
  return (
    <div className="page-container">
      {(title || extra) && (
        <div className="page-header">
          <div className="page-title">{title}</div>
          {extra && <div className="page-extra">{extra}</div>}
        </div>
      )}
      <div className="page-body">{children}</div>
    </div>
  );
}
