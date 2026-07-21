import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Tag, Typography } from 'antd';
import {
  ClockCircleOutlined,
  CheckCircleOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { reportApi } from '../../api/report';
import { DashboardData } from '../../types';
import { usePermission } from '../../hooks/usePermission';
import { useAuthStore } from '../../stores/authStore';
import LazyEChart from '../../components/Charts/LazyEChart';

const getGreeting = (date: Date) => {
  const hour = date.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
};

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const { hasPermission } = usePermission();
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchData();
  }, []);

  // 窗口重新获得焦点时刷新数据（从其它页面返回 Dashboard 后数据自动更新）
  useEffect(() => {
    const onFocus = () => fetchData();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await reportApi.getDashboard();
      if (res.data) setData(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || '工作台数据加载失败');
    } finally {
      setLoading(false);
    }
  };

  const trendOption = data?.trend ? {
    tooltip: { trigger: 'axis' as const },
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: data.trend.map(t => t.date),
      axisLabel: { fontSize: 11, color: '#9A9080' },
      axisLine: { lineStyle: { color: '#E8E0D4' } },
    },
    yAxis: {
      type: 'value' as const,
      name: '工时(天)',
      axisLabel: { color: '#9A9080' },
      splitLine: { lineStyle: { color: '#E8E0D4' } },
    },
    series: [{
      data: data.trend.map(t => t.days),
      type: 'line' as const,
      smooth: true,
      areaStyle: {
        color: {
          type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(107,143,113,0.25)' },
            { offset: 1, color: 'rgba(107,143,113,0.02)' },
          ],
        },
      },
      lineStyle: { color: '#6B8F71', width: 2.5 },
      itemStyle: { color: '#6B8F71' },
    }],
  } : null;

  const todoItems = [];
  if (hasPermission('timesheet:create')) {
    todoItems.push({ title: '提交本周工时', tag: '工时', color: 'green', path: '/timesheet' });
  }
  if (hasPermission('weekly_report:create')) {
    todoItems.push({ title: '提交本周周报', tag: '周报', color: 'green', path: '/weekly-report' });
  }
  if ((data?.pendingCount || 0) > 0) {
    todoItems.push({ title: `审批工时申请 (${data?.pendingCount || 0})`, tag: '审批', color: 'orange', path: '/approval' });
  }

  const statCards = [
    hasPermission('timesheet:view:self') && {
      icon: <ClockCircleOutlined />,
      value: `${data?.monthDays || 0}天`,
      label: '本月工时',
      color: '#6B8F71',
      bg: '#EAF0EB',
    },
    (data?.pendingCount || 0) > 0 && {
      icon: <CheckCircleOutlined />,
      value: `${data?.pendingCount || 0}`,
      label: '待审批',
      color: '#C89B50',
      bg: '#F5F0E0',
    },
    hasPermission('overtime:view:self') && {
      icon: <ThunderboltOutlined />,
      value: `${data?.overtimeDays || 0}天`,
      label: '本月加班',
      color: '#C0564B',
      bg: '#F5E8E6',
    },
      hasPermission('weekly_report:view:self') && {
      icon: <FileTextOutlined />,
      value: '待提交',
      label: '本周周报',
      color: '#6B8F71',
      bg: '#EAF0EB',
    },
  ].filter(Boolean) as { icon: React.ReactNode; value: string; label: string; color: string; bg: string }[];

  return (
    <div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Hero */}
      <div style={{ maxWidth: 520, marginBottom: 36 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: '#6B8F71',
          marginBottom: 4, letterSpacing: '0.02em',
        }}>
          {now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
        </div>
        <h1 style={{
          fontFamily: '"Fraunces", Georgia, serif',
          fontSize: 'clamp(26px, 3.5vw, 36px)',
          fontWeight: 900,
          lineHeight: 1.15,
          color: '#2C2418',
          margin: 0,
        }}>
          {getGreeting(now)}，{user?.realName || '用户'}
        </h1>
        <div style={{ marginTop: 8, fontSize: 15, color: '#7A7060', lineHeight: 1.5 }}>
          本月已填报 {data?.monthDays || 0} 天
          {data?.pendingCount ? `，还有 ${data.pendingCount} 条审批需要处理。` : '。'}
        </div>
      </div>

      {/* 统计卡片 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 36, flexWrap: 'wrap' }}>
        {statCards.map((stat, i) => (
          <div
            key={i}
            style={{
              flex: '1 1 180px',
              padding: '20px 24px',
              borderRadius: 16,
              background: '#FDFBF7',
              border: '1px solid #E8E0D4',
              transition: 'all 0.25s ease',
              cursor: 'default',
            }}
          >
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: stat.bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, color: stat.color,
              marginBottom: 12,
            }}>
              {stat.icon}
            </div>
            <div style={{
              fontSize: 28, fontWeight: 700, color: '#2C2418', lineHeight: 1,
            }}>
              {stat.value}
            </div>
            <div style={{
              fontSize: 12, fontWeight: 500, color: '#9A9080', marginTop: 4,
            }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* 双栏内容 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
        {/* 工时趋势 */}
        <div style={{
          background: '#FDFBF7',
          border: '1px solid #E8E0D4',
          borderRadius: 16,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '18px 22px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#2C2418' }}>本月工时趋势</span>
          </div>
          <div style={{ padding: '0 22px 18px' }}>
            {trendOption ? (
              <LazyEChart option={trendOption} style={{ height: 300 }} />
            ) : (
              <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#B0A898' }}>
                暂无数据
              </div>
            )}
          </div>
        </div>

        {/* 待办 & 快捷 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 快捷操作 */}
          <div style={{
            background: '#FDFBF7',
            border: '1px solid #E8E0D4',
            borderRadius: 16,
            padding: '18px 22px',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#2C2418', marginBottom: 14 }}>
              快捷操作
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { icon: '✏️', title: '填报工时', desc: '记录今天的工作', path: '/timesheet', perm: 'timesheet:create' },
                { icon: '📤', title: '提交周工时', desc: '一键提交审批', path: '/timesheet', perm: 'timesheet:create' },
                { icon: '📊', title: '月度统计', desc: '工时趋势分析', path: '/report', perm: 'report:access' },
                { icon: '✅', title: '审批中心', desc: `${data?.pendingCount || 0} 条待处理`, path: '/approval', perm: '', visible: (data?.pendingCount || 0) > 0 },
              ].filter(item => item.visible !== false && (!item.perm || hasPermission(item.perm))).map((item, i) => (
                <div
                  key={i}
                  onClick={() => navigate(item.path)}
                  style={{
                    padding: '14px 16px', borderRadius: 12,
                    background: '#F8F4ED', cursor: 'pointer',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#EDE8DE'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#F8F4ED'; }}
                >
                  <div style={{ fontSize: 20, marginBottom: 6 }}>{item.icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#2C2418' }}>{item.title}</div>
                  <div style={{ fontSize: 11, color: '#9A9080', marginTop: 2 }}>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 待办 */}
          <div style={{
            background: '#FDFBF7',
            border: '1px solid #E8E0D4',
            borderRadius: 16,
            padding: '18px 22px',
            flex: 1,
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#2C2418', marginBottom: 12 }}>
              待办事项
            </div>
            {todoItems.length > 0 ? (
              <div>
                {todoItems.map((item, i) => (
                  <div
                    key={i}
                    onClick={() => navigate(item.path)}
                    style={{
                      padding: '10px 0',
                      borderBottom: i < todoItems.length - 1 ? '1px solid #F0EBE2' : 'none',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#2C2418' }}>{item.title}</span>
                    <Tag color={item.color} style={{ borderRadius: 999, fontSize: 11, margin: 0 }}>{item.tag}</Tag>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: 24, textAlign: 'center', color: '#B0A898' }}>
                暂无待办事项
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
