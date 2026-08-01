import { ReactNode } from 'react';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {(title || extra) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#2C2418', margin: 0 }}>{title}</div>
          {extra && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{extra}</div>}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div>
    </div>
  );
}
