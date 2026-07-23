import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@client/components/Charts/EChart', () => ({
  default: ({ option, style }: any) => (
    <div data-testid="loaded-chart" data-title={option.title.text} style={style} />
  ),
}));

import LazyEChart from '@client/components/Charts/LazyEChart';

describe('LazyEChart', () => {
  it('按需加载图表并原样传递配置和样式', async () => {
    render(<LazyEChart option={{ title: { text: '工时趋势' } }} style={{ height: 280 }} />);

    const chart = await screen.findByTestId('loaded-chart');
    expect(chart).toHaveAttribute('data-title', '工时趋势');
    expect(chart).toHaveStyle({ height: '280px' });
  });
});
