import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageContainer } from '@client/components/PageContainer';

describe('PageContainer', () => {
  it('统一呈现标题、操作区和页面内容', () => {
    const { container } = render(
      <PageContainer title="工时管理" extra={<button>新增</button>}>
        <p>正文内容</p>
      </PageContainer>,
    );

    expect(screen.getByText('工时管理')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增' })).toBeInTheDocument();
    expect(screen.getByText('正文内容')).toBeInTheDocument();
    expect(container.querySelector('.page-header')).toBeInTheDocument();
  });

  it('没有标题操作时不生成空白页头', () => {
    const { container } = render(<PageContainer><span>正文</span></PageContainer>);
    expect(container.querySelector('.page-header')).toBeNull();
  });
});
