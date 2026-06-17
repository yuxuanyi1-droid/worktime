import { lazy, Suspense } from 'react';
import { Spin } from 'antd';
import type { EChartsCoreOption } from 'echarts/core';

const EChart = lazy(() => import('./EChart'));

type LazyEChartProps = {
  option: EChartsCoreOption;
  style?: React.CSSProperties;
};

export default function LazyEChart({ option, style }: LazyEChartProps) {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: typeof style?.height === 'number' ? style.height : 240,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Spin />
        </div>
      }
    >
      <EChart option={option} style={style} />
    </Suspense>
  );
}
