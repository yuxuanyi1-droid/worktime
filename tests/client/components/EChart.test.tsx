import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chart = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
}));
const init = vi.hoisted(() => vi.fn(() => chart));
const use = vi.hoisted(() => vi.fn());

vi.mock('echarts/core', () => ({ init, use }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {}, PieChart: {} }));
vi.mock('echarts/components', () => ({
  GridComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  TitleComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

import EChart from '@client/components/Charts/EChart';

describe('EChart', () => {
  let resizeCallback: ResizeObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    chart.setOption.mockReset();
    chart.resize.mockReset();
    chart.dispose.mockReset();
    init.mockClear();
    observe.mockReset();
    disconnect.mockReset();
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  });

  it('初始化图表、响应尺寸与配置变化，并在卸载时释放资源', () => {
    const firstOption = { title: { text: '第一版' } };
    const secondOption = { title: { text: '第二版' } };
    const { container, rerender, unmount } = render(
      <EChart option={firstOption} style={{ height: 320 }} />,
    );
    const element = container.firstElementChild as HTMLDivElement;

    expect(init).toHaveBeenCalledWith(element);
    expect(observe).toHaveBeenCalledWith(element);
    expect(chart.setOption).toHaveBeenLastCalledWith(firstOption, true);
    expect(element).toHaveStyle({ width: '100%', height: '320px' });

    rerender(<EChart option={secondOption} />);
    expect(init).toHaveBeenCalledOnce();
    expect(chart.setOption).toHaveBeenLastCalledWith(secondOption, true);

    resizeCallback([], {} as ResizeObserver);
    expect(chart.resize).toHaveBeenCalledOnce();

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(chart.dispose).toHaveBeenCalledOnce();
  });
});
