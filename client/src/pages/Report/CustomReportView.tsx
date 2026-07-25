import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  customReportApi,
  type CustomDefinitionPayload,
  type CustomReportCell,
  type CustomReportConfig,
  type CustomReportDefinition,
  type CustomReportDimension,
  type CustomReportMeasure,
  type CustomReportResult,
  type CustomReportScopeType,
  type CustomReportSource,
} from '../../api/report';
import type { ReportScope } from '../../types';
import LazyEChart from '../../components/Charts/LazyEChart';
import { usePermission } from '../../hooks/usePermission';
import { useAuthStore } from '../../stores/authStore';

const { Text } = Typography;

// 复用 Report 页同款色板，保持视觉一致
const palette = ['#4F7B63', '#B7791F', '#B85C5C', '#4F6F8F', '#7A6C5D', '#6D7E3F', '#8C6A9E'];

const SOURCE_OPTIONS: { value: CustomReportSource; label: string }[] = [
  { value: 'timesheet', label: '工时' },
  { value: 'overtime', label: '加班' },
];

const DIMENSION_OPTIONS: { value: CustomReportDimension; label: string }[] = [
  { value: 'user', label: '人员' },
  { value: 'project', label: '项目' },
  { value: 'date', label: '日期' },
  { value: 'month', label: '月份' },
  { value: 'department', label: '部门' },
  { value: 'group', label: '组别' },
  { value: 'overtimeType', label: '加班类型' },
];

const MEASURE_OPTIONS: { value: CustomReportMeasure; label: string }[] = [
  { value: 'sumDays', label: '天数' },
  { value: 'count', label: '记录数' },
  { value: 'distinctUsers', label: '人数' },
];

const MEASURE_LABEL: Record<CustomReportMeasure, string> = {
  sumDays: '天数',
  count: '记录数',
  distinctUsers: '人数',
};

const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿' },
  { value: 'submitted', label: '审批中' },
  { value: 'approved', label: '已审批' },
  { value: 'rejected', label: '已驳回' },
  { value: 'withdrawn', label: '已撤回' },
];

const OVERTIME_TYPE_OPTIONS = [
  { value: 'weekend', label: '周末加班' },
  { value: 'holiday', label: '节假日加班' },
  { value: 'weekday', label: '工作日加班' },
];

const SCOPE_OPTIONS: { value: CustomReportScopeType; label: string }[] = [
  { value: 'private', label: '仅自己' },
  { value: 'group', label: '所在组' },
  { value: 'department', label: '所在部门' },
  { value: 'public', label: '全员' },
];

const SCOPE_LABEL: Record<CustomReportScopeType, string> = {
  private: '仅自己',
  group: '所在组',
  department: '所在部门',
  public: '全员',
};

type ChartType = 'bar' | 'line' | 'pie';

interface PivotRow {
  key: string;
  rowLabel: string;
  cells?: Record<string, CustomReportCell>;
  total?: CustomReportCell;
}

function makeDefaultConfig(): CustomReportConfig {
  return {
    source: 'timesheet',
    startDate: dayjs().startOf('month').format('YYYY-MM-DD'),
    endDate: dayjs().endOf('month').format('YYYY-MM-DD'),
    rowDimension: 'user',
    colDimension: null,
    measures: ['sumDays'],
    filters: { statuses: ['approved'] },
  };
}

function fmtNum(v: number | undefined | null): string {
  if (v === undefined || v === null) return '-';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function renderCell(cell: CustomReportCell | undefined, measures: CustomReportMeasure[]) {
  if (!cell) return <Text type="secondary">-</Text>;
  if (measures.length === 1) {
    return <span>{fmtNum(cell[measures[0]])}</span>;
  }
  return (
    <div style={{ lineHeight: 1.5 }}>
      {measures.map((m) => (
        <div key={m}>
          <Text type="secondary" style={{ fontSize: 12 }}>{MEASURE_LABEL[m]}:</Text> {fmtNum(cell[m])}
        </div>
      ))}
    </div>
  );
}

function makeCustomBarOption(result: CustomReportResult, measures: CustomReportMeasure[], type: 'bar' | 'line') {
  const rowLabels = result.rowKeys.map((rk) => rk.label);
  const series = measures.map((m) => ({
    name: MEASURE_LABEL[m],
    type,
    data: result.rowKeys.map((rk) => result.rowTotals[rk.key]?.[m] ?? 0),
    barMaxWidth: 32,
    itemStyle: type === 'bar' ? { borderRadius: [4, 4, 0, 0] } : undefined,
    smooth: type === 'line',
  }));
  return {
    color: palette,
    tooltip: { trigger: 'axis' as const },
    legend: { bottom: 0 },
    grid: { left: 48, right: 20, top: 28, bottom: 56 },
    xAxis: {
      type: 'category' as const,
      data: rowLabels,
      axisLabel: { rotate: rowLabels.length > 6 ? 30 : 0, interval: 0 },
    },
    yAxis: { type: 'value' as const },
    series,
  };
}

function makeCustomPieOption(result: CustomReportResult, measure: CustomReportMeasure) {
  const data = result.rowKeys
    .map((rk) => ({ name: rk.label, value: result.rowTotals[rk.key]?.[measure] ?? 0 }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  return {
    color: palette,
    tooltip: { trigger: 'item' as const, formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, type: 'scroll' as const },
    series: [
      {
        type: 'pie' as const,
        radius: ['42%', '68%'],
        center: ['50%', '44%'],
        data,
        label: { formatter: '{b}' },
      },
    ],
  };
}

function hasChartData(option: any) {
  const series = option?.series?.[0];
  return Array.isArray(series?.data) && series.data.length > 0;
}

interface CustomReportViewProps {
  scope: ReportScope | null;
  scopeLoading: boolean;
}

export default function CustomReportView({ scope, scopeLoading }: CustomReportViewProps) {
  const { hasPermission } = usePermission();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const canManage = hasPermission('report:custom:manage');

  const [config, setConfig] = useState<CustomReportConfig>(makeDefaultConfig);
  const [result, setResult] = useState<CustomReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<ChartType>('bar');

  const [definitions, setDefinitions] = useState<CustomReportDefinition[]>([]);
  const [defsLoading, setDefsLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveForm] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const updateConfig = (patch: Partial<CustomReportConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  };

  // 维度可选项：工时数据源下隐藏「加班类型」维度，避免无效组合
  const dimensionOptions = useMemo(() => {
    if (config.source === 'timesheet') {
      return DIMENSION_OPTIONS.filter((o) => o.value !== 'overtimeType');
    }
    return DIMENSION_OPTIONS;
  }, [config.source]);

  const rowDimLabel = useMemo(
    () => DIMENSION_OPTIONS.find((d) => d.value === config.rowDimension)?.label || '行',
    [config.rowDimension],
  );

  /** 切换数据源时清掉对当前源无效的维度/筛选 */
  const handleSourceChange = (src: CustomReportSource) => {
    const patch: Partial<CustomReportConfig> = { source: src };
    const nextFilters = { ...config.filters };
    if (src === 'timesheet') {
      if (config.rowDimension === 'overtimeType') patch.rowDimension = 'user';
      if (config.colDimension === 'overtimeType') patch.colDimension = null;
      delete nextFilters.overtimeType;
      patch.filters = nextFilters;
    }
    setConfig({ ...config, ...patch });
  };

  const runReport = async (cfg: CustomReportConfig = config) => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await customReportApi.run(cfg);
      setResult(res.data || null);
    } catch (err: any) {
      setResult(null);
      setRunError(err?.response?.data?.message || err?.message || '运行失败');
    } finally {
      setRunning(false);
    }
  };

  const loadDefinitions = async () => {
    setDefsLoading(true);
    try {
      const res = await customReportApi.listDefinitions();
      setDefinitions(res.data || []);
    } catch {
      // 列表加载失败不阻塞构建器，静默处理
    } finally {
      setDefsLoading(false);
    }
  };

  useEffect(() => {
    loadDefinitions();
  }, []);

  const loadDefinition = (def: CustomReportDefinition) => {
    setConfig(def.config);
    setEditingId(def.id);
    setResult(null);
    setRunError(null);
    message.info(`已加载「${def.name}」配置`);
  };

  const handleNew = () => {
    setConfig(makeDefaultConfig());
    setEditingId(null);
    setResult(null);
    setRunError(null);
  };

  const openSave = () => {
    saveForm.resetFields();
    saveForm.setFieldsValue({ name: '', scope: 'private', scopeGroupId: undefined, scopeDepartmentId: undefined });
    setSaveOpen(true);
  };

  const handleSave = async () => {
    let values: any;
    try {
      values = await saveForm.validateFields();
    } catch {
      return; // 校验失败，表单内已提示
    }
    setSaving(true);
    try {
      const payload: CustomDefinitionPayload = {
        name: values.name,
        config,
        scope: values.scope,
        scopeGroupId: values.scope === 'group' ? values.scopeGroupId : undefined,
        scopeDepartmentId: values.scope === 'department' ? values.scopeDepartmentId : undefined,
      };
      if (editingId) {
        const res = await customReportApi.updateDefinition(editingId, payload);
        message.success('报表已更新');
        setEditingId(res.data?.id ?? editingId);
      } else {
        const res = await customReportApi.createDefinition(payload);
        setEditingId(res.data?.id ?? null);
        message.success('报表已保存');
      }
      setSaveOpen(false);
      loadDefinitions();
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await customReportApi.deleteDefinition(id);
      message.success('已删除');
      if (editingId === id) setEditingId(null);
      loadDefinitions();
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || '删除失败');
    }
  };

  // ==================== 透视表构造 ====================
  const hasCols = !!result && result.colKeys.length > 0;

  const pivotColumns = useMemo(() => {
    if (!result) return [];
    const measures = config.measures;
    const cols: any[] = [
      {
        title: rowDimLabel,
        dataIndex: 'rowLabel',
        key: 'rowLabel',
        fixed: 'left',
        width: 160,
        render: (text: string) => <Text strong>{text}</Text>,
      },
    ];
    if (hasCols) {
      result.colKeys.forEach((ck) => {
        cols.push({
          title: ck.label,
          key: `col_${ck.key}`,
          align: 'right' as const,
          render: (_: any, record: PivotRow) => renderCell(record.cells?.[ck.key], measures),
        });
      });
      cols.push({
        title: '合计',
        key: 'total',
        align: 'right' as const,
        render: (_: any, record: PivotRow) => renderCell(record.total, measures),
      });
    } else {
      // 无列维度：把每个度量展开成一列，行合计即单元格
      measures.forEach((m) => {
        cols.push({
          title: MEASURE_LABEL[m],
          key: `m_${m}`,
          align: 'right' as const,
          render: (_: any, record: PivotRow) => fmtNum(record.total?.[m]),
        });
      });
    }
    return cols;
  }, [result, config.measures, rowDimLabel, hasCols]);

  const pivotData: PivotRow[] = useMemo(() => {
    if (!result) return [];
    return result.rowKeys.map((rk) => ({
      key: rk.key,
      rowLabel: rk.label,
      cells: result.cells[rk.key],
      total: result.rowTotals[rk.key],
    }));
  }, [result]);

  const chartOption = useMemo(() => {
    if (!result || result.rowKeys.length === 0) return null;
    if (chartType === 'pie') {
      return makeCustomPieOption(result, config.measures[0]);
    }
    return makeCustomBarOption(result, config.measures, chartType);
  }, [result, chartType, config.measures]);

  const scopeGroupOptions = (scope?.groups || []).map((g) => ({
    label: g.department?.name ? `${g.department.name} / ${g.name}` : g.name,
    value: g.id,
  }));
  const scopeDeptOptions = (scope?.departments || []).map((d) => ({ label: d.name, value: d.id }));

  return (
    <div>
      {/* ==================== 报表构建器 ==================== */}
      <Card
        title="自定义报表构建器"
        style={{ borderRadius: 8, marginBottom: 16 }}
        extra={
          editingId ? (
            <Tag color="blue">正在编辑已保存报表</Tag>
          ) : (
            <Tag color="default">未保存配置</Tag>
          )
        }
      >
        <Spin spinning={scopeLoading}>
          <Row gutter={[12, 16]}>
            <Col xs={24} sm={12} md={6}>
              <div style={{ marginBottom: 4 }}><Text type="secondary">数据源</Text></div>
              <Select
                style={{ width: '100%' }}
                value={config.source}
                onChange={handleSourceChange}
                options={SOURCE_OPTIONS}
              />
            </Col>
            <Col xs={24} sm={12} md={10}>
              <div style={{ marginBottom: 4 }}><Text type="secondary">日期范围</Text></div>
              <DatePicker.RangePicker
                style={{ width: '100%' }}
                value={[dayjs(config.startDate), dayjs(config.endDate)]}
                onChange={(value) => {
                  if (value && value[0] && value[1]) {
                    updateConfig({
                      startDate: value[0].format('YYYY-MM-DD'),
                      endDate: value[1].format('YYYY-MM-DD'),
                    });
                  }
                }}
              />
            </Col>
            <Col xs={24} sm={12} md={4}>
              <div style={{ marginBottom: 4 }}><Text type="secondary">&nbsp;</Text></div>
              <Button icon={<SaveOutlined />} onClick={handleNew}>新建配置</Button>
            </Col>

            <Col xs={24} sm={12} md={6}>
              <div style={{ marginBottom: 4 }}><Text type="secondary">行维度</Text></div>
              <Select
                style={{ width: '100%' }}
                value={config.rowDimension}
                onChange={(v: CustomReportDimension) => updateConfig({ rowDimension: v })}
                options={dimensionOptions}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <div style={{ marginBottom: 4 }}><Text type="secondary">列维度</Text></div>
              <Select
                style={{ width: '100%' }}
                value={config.colDimension || ''}
                onChange={(v: string) => updateConfig({ colDimension: v ? (v as CustomReportDimension) : null })}
                options={[{ value: '', label: '无' }, ...dimensionOptions]}
              />
            </Col>
            <Col xs={24} md={12}>
              <div style={{ marginBottom: 4 }}><Text type="secondary">度量</Text></div>
              <Checkbox.Group
                value={config.measures}
                onChange={(vals) => {
                  const measures = vals as CustomReportMeasure[];
                  updateConfig({ measures: measures.length === 0 ? config.measures : measures });
                }}
                options={MEASURE_OPTIONS}
              />
            </Col>
          </Row>

          <Divider style={{ margin: '12px 0' }} />
          <Text type="secondary">筛选条件</Text>
          <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
            <Col xs={24} sm={12} md={6}>
              <Select
                mode="multiple"
                allowClear
                placeholder="部门（全部）"
                style={{ width: '100%' }}
                value={config.filters.departmentIds || []}
                onChange={(vals: number[]) => updateConfig({ filters: { ...config.filters, departmentIds: vals.length ? vals : undefined } })}
                options={scopeDeptOptions}
                optionFilterProp="label"
                maxTagCount="responsive"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Select
                mode="multiple"
                allowClear
                placeholder="组别（全部）"
                style={{ width: '100%' }}
                value={config.filters.groupIds || []}
                onChange={(vals: number[]) => updateConfig({ filters: { ...config.filters, groupIds: vals.length ? vals : undefined } })}
                options={scopeGroupOptions}
                optionFilterProp="label"
                maxTagCount="responsive"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Select
                mode="multiple"
                allowClear
                placeholder="项目（全部）"
                style={{ width: '100%' }}
                value={config.filters.projectIds || []}
                onChange={(vals: number[]) => updateConfig({ filters: { ...config.filters, projectIds: vals.length ? vals : undefined } })}
                options={(scope?.projects || []).map((p) => ({ label: `${p.name}（${p.code}）`, value: p.id }))}
                optionFilterProp="label"
                maxTagCount="responsive"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Select
                mode="tags"
                allowClear
                placeholder="人员ID（回车添加）"
                style={{ width: '100%' }}
                tokenSeparators={[',', ' '] as any}
                value={(config.filters.userIds || []).map(String)}
                onChange={(vals: string[]) =>
                  updateConfig({
                    filters: {
                      ...config.filters,
                      userIds: vals
                        .map((v) => Number(v))
                        .filter((n) => Number.isFinite(n) && n > 0),
                    },
                  })
                }
                maxTagCount="responsive"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Select
                mode="multiple"
                allowClear
                placeholder="状态（默认已审批）"
                style={{ width: '100%' }}
                value={config.filters.statuses || []}
                onChange={(vals: string[]) => updateConfig({ filters: { ...config.filters, statuses: vals.length ? vals : undefined } })}
                options={STATUS_OPTIONS}
                maxTagCount="responsive"
              />
            </Col>
            {config.source === 'overtime' && (
              <Col xs={24} sm={12} md={6}>
                <Select
                  allowClear
                  placeholder="加班类型（全部）"
                  style={{ width: '100%' }}
                  value={config.filters.overtimeType}
                  onChange={(v?: string) => updateConfig({ filters: { ...config.filters, overtimeType: v || undefined } })}
                  options={OVERTIME_TYPE_OPTIONS}
                />
              </Col>
            )}
          </Row>

          <Divider style={{ margin: '12px 0' }} />
          <Space wrap>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={running} onClick={() => runReport()}>
              运行预览
            </Button>
            {canManage && (
              <Button icon={<SaveOutlined />} onClick={openSave}>
                {editingId ? '另存 / 更新' : '保存报表'}
              </Button>
            )}
          </Space>
        </Spin>
      </Card>

      {/* ==================== 预览结果 ==================== */}
      {runError && (
        <Alert
          type="error"
          showIcon
          message={runError}
          action={<Button size="small" onClick={() => runReport()} loading={running}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card
        title="预览结果"
        style={{ borderRadius: 8, marginBottom: 16 }}
        extra={
          result && (
            <Segmented
              value={chartType}
              onChange={(v) => setChartType(v as ChartType)}
              options={[
                { value: 'bar', label: '柱状图' },
                { value: 'line', label: '折线图' },
                { value: 'pie', label: '饼图' },
              ]}
            />
          )
        }
      >
        <Spin spinning={running}>
          {!result && (
            <Empty description="配置好构建器后点击「运行预览」查看结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
          {result && (
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={12}>
                <Card type="inner" title="图表" style={{ borderRadius: 8 }}>
                  {chartOption && hasChartData(chartOption) ? (
                    <LazyEChart option={chartOption} style={{ height: 320 }} />
                  ) : (
                    <Empty description="暂无可绘制数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  )}
                </Card>
              </Col>
              <Col xs={24} xl={12}>
                <Card type="inner" title="透视表" style={{ borderRadius: 8 }}>
                  <Table<PivotRow>
                    size="small"
                    pagination={false}
                    columns={pivotColumns}
                    dataSource={pivotData}
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: '暂无数据' }}
                    summary={() => {
                      if (!result || result.rowKeys.length === 0) return null;
                      if (hasCols) {
                        const cells = [
                          <Table.Summary.Cell key="label" index={0}>
                            <Text strong>总计</Text>
                          </Table.Summary.Cell>,
                          ...result.colKeys.map((ck, i) => (
                            <Table.Summary.Cell key={ck.key} index={i + 1} align="right">
                              {renderCell(result.colTotals[ck.key], config.measures)}
                            </Table.Summary.Cell>
                          )),
                          <Table.Summary.Cell key="grand" index={result.colKeys.length + 1} align="right">
                            {renderCell(result.grandTotal, config.measures)}
                          </Table.Summary.Cell>,
                        ];
                        return <Table.Summary.Row>{cells}</Table.Summary.Row>;
                      }
                      const cells = [
                        <Table.Summary.Cell key="label" index={0}>
                          <Text strong>总计</Text>
                        </Table.Summary.Cell>,
                        ...config.measures.map((m, i) => (
                          <Table.Summary.Cell key={m} index={i + 1} align="right">
                            <Text strong>{fmtNum(result.grandTotal[m])}</Text>
                          </Table.Summary.Cell>
                        )),
                      ];
                      return <Table.Summary.Row>{cells}</Table.Summary.Row>;
                    }}
                  />
                </Card>
              </Col>
            </Row>
          )}
        </Spin>
      </Card>

      {/* ==================== 我的 / 共享报表 ==================== */}
      <Card
        title="我的 / 共享报表"
        style={{ borderRadius: 8 }}
        extra={<Button size="small" onClick={loadDefinitions} loading={defsLoading}>刷新</Button>}
      >
        <Spin spinning={defsLoading}>
          {definitions.length === 0 ? (
            <Empty description="暂无已保存的报表" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table<CustomReportDefinition>
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={definitions}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: '名称',
                  dataIndex: 'name',
                  render: (text: string, record) => (
                    <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => loadDefinition(record)}>
                      {text}
                    </Button>
                  ),
                },
                {
                  title: '共享范围',
                  dataIndex: 'scope',
                  width: 110,
                  render: (s: CustomReportScopeType) => <Tag>{SCOPE_LABEL[s] || s}</Tag>,
                },
                { title: '创建人', dataIndex: ['owner', 'realName'], width: 120 },
                {
                  title: '创建时间',
                  dataIndex: 'createdAt',
                  width: 160,
                  render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
                },
                {
                  title: '操作',
                  key: 'actions',
                  width: 180,
                  render: (_: any, record) => {
                    const isOwner = !!currentUserId && record.owner?.id === currentUserId;
                    return (
                      <Space size="small">
                        <Button size="small" onClick={() => loadDefinition(record)}>加载</Button>
                        {canManage && isOwner && (
                          <>
                            <Button size="small" icon={<EditOutlined />} onClick={openSave}>
                              编辑
                            </Button>
                            <Popconfirm
                              title="确认删除该报表？"
                              onConfirm={() => handleDelete(record.id)}
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                            >
                              <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                            </Popconfirm>
                          </>
                        )}
                      </Space>
                    );
                  },
                },
              ]}
            />
          )}
        </Spin>
      </Card>

      {/* ==================== 保存 / 编辑 弹窗 ==================== */}
      <Modal
        open={saveOpen}
        title={editingId ? '更新报表' : '保存报表'}
        onCancel={() => setSaveOpen(false)}
        confirmLoading={saving}
        onOk={handleSave}
        okText={editingId ? '更新' : '保存'}
        cancelText="取消"
        destroyOnClose
      >
        <Form form={saveForm} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="报表名称"
            rules={[{ required: true, message: '请输入报表名称' }, { max: 60, message: '名称不超过 60 字' }]}
          >
            <Input placeholder="如：本月各组工时透视" maxLength={60} />
          </Form.Item>
          <Form.Item
            name="scope"
            label="共享范围"
            rules={[{ required: true, message: '请选择共享范围' }]}
          >
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.scope !== cur.scope}>
            {({ getFieldValue }) => {
              const scopeType: CustomReportScopeType = getFieldValue('scope');
              if (scopeType === 'group') {
                return (
                  <Form.Item
                    name="scopeGroupId"
                    label="共享到组"
                    rules={[{ required: true, message: '请选择组' }]}
                  >
                    <Select placeholder="选择组" options={scopeGroupOptions} optionFilterProp="label" showSearch />
                  </Form.Item>
                );
              }
              if (scopeType === 'department') {
                return (
                  <Form.Item
                    name="scopeDepartmentId"
                    label="共享到部门"
                    rules={[{ required: true, message: '请选择部门' }]}
                  >
                    <Select placeholder="选择部门" options={scopeDeptOptions} optionFilterProp="label" showSearch />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
