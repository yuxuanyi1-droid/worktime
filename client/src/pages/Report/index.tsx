import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Divider,
  Empty,
  Row,
  Select,
  Spin,
  Statistic,
  Table,
  Tabs,
  Typography,
  message,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportApi } from '../../api/report';
import { DepartmentReport, GroupReport, OvertimeReport, PersonalReport, ProjectReport, ReportScope } from '../../types';
import request from '../../utils/request';
import LazyEChart from '../../components/Charts/LazyEChart';

const { Title, Text } = Typography;
type ReportTabKey = 'personal' | 'group' | 'department' | 'project' | 'overtime';
type SummaryValue = { days: number; count?: number };

const palette = ['#4F7B63', '#B7791F', '#B85C5C', '#4F6F8F', '#7A6C5D', '#6D7E3F', '#8C6A9E'];
const emptyText = '选择筛选条件后点击查询';

function Chart({ option, height = 300 }: { option: any; height?: number }) {
  return <LazyEChart option={option} style={{ height }} />;
}

function hasChartData(option: any) {
  const series = option?.series?.[0];
  return Array.isArray(series?.data) && series.data.length > 0;
}

function sortEntries<T>(data?: Record<string, T>) {
  return Object.entries(data || {}).sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
}

function summaryEntries(data?: Record<string, SummaryValue>) {
  return Object.entries(data || {}).sort(([, a], [, b]) => Number(b.days) - Number(a.days));
}

function totalCount(data?: Record<string, SummaryValue>) {
  return Object.values(data || {}).reduce((sum, item) => sum + (item.count || 0), 0);
}

function makeTrendOption(byDate?: Record<string, number>, unit = '天') {
  const entries = sortEntries(byDate);
  return {
    color: [palette[0]],
    tooltip: { trigger: 'axis' as const, valueFormatter: (value: number) => `${value}${unit}` },
    grid: { left: 42, right: 20, top: 28, bottom: 36 },
    xAxis: { type: 'category' as const, boundaryGap: false, data: entries.map(([date]) => date.slice(5)) },
    yAxis: { type: 'value' as const, name: unit },
    series: [{
      type: 'line' as const,
      smooth: true,
      symbolSize: 7,
      areaStyle: { color: 'rgba(79, 123, 99, 0.12)' },
      data: entries.map(([, value]) => value),
    }],
  };
}

function makePieOption(data?: Record<string, SummaryValue> | Record<string, number>, unit = '天') {
  const entries = Object.entries(data || {})
    .map(([name, value]) => ({ name, value: typeof value === 'number' ? value : value.days }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);

  return {
    color: palette,
    tooltip: { trigger: 'item' as const, formatter: `{b}: {c}${unit} ({d}%)` },
    legend: { bottom: 0, type: 'scroll' as const },
    series: [{
      type: 'pie' as const,
      radius: ['42%', '68%'],
      center: ['50%', '44%'],
      data: entries,
      label: { formatter: '{b}' },
    }],
  };
}

function makeBarOption(data?: Record<string, SummaryValue> | Record<string, number>, unit = '天', color = palette[0]) {
  const entries = Object.entries(data || {})
    .map(([name, value]) => ({ name, value: typeof value === 'number' ? value : value.days }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  return {
    color: [color],
    tooltip: { trigger: 'axis' as const, valueFormatter: (value: number) => `${value}${unit}` },
    grid: { left: 42, right: 18, top: 28, bottom: 56 },
    xAxis: {
      type: 'category' as const,
      data: entries.map((item) => item.name),
      axisLabel: { interval: 0, rotate: entries.length > 5 ? 28 : 0 },
    },
    yAxis: { type: 'value' as const, name: unit },
    series: [{
      type: 'bar' as const,
      data: entries.map((item) => item.value),
      barMaxWidth: 36,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
    }],
  };
}

function DataChart({ title, option, empty = emptyText }: { title: string; option: any; empty?: string }) {
  return (
    <Card title={title} style={{ borderRadius: 8 }}>
      {hasChartData(option) ? <Chart option={option} /> : <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
    </Card>
  );
}

function SummaryCard({ title, total, count }: { title: string; total?: number; count?: number }) {
  return (
    <Card title={title} style={{ borderRadius: 8 }}>
      <Statistic title="总工时" value={total || 0} suffix="天" precision={1} />
      <Divider />
      <Statistic title="记录数" value={count || 0} suffix="条" />
    </Card>
  );
}

function SummaryTable({ data, nameTitle, unit = '天' }: { data?: Record<string, SummaryValue>; nameTitle: string; unit?: string }) {
  return (
    <Table
      size="small"
      pagination={false}
      dataSource={summaryEntries(data).map(([name, value]) => ({
        key: name,
        name,
        days: value.days,
        count: value.count || 0,
      }))}
      columns={[
        { title: nameTitle, dataIndex: 'name' },
        { title: `工时(${unit})`, dataIndex: 'days', align: 'right' as const },
        { title: '记录数', dataIndex: 'count', align: 'right' as const },
      ]}
      locale={{ emptyText: '暂无数据' }}
    />
  );
}

function uniqueById<T extends { id: number }>(items: T[]) {
  const map = new Map<number, T>();
  items.forEach((item) => map.set(item.id, item));
  return Array.from(map.values());
}

function PersonalView({ data }: { data: PersonalReport | null }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <DataChart title="每日工时趋势" option={makeTrendOption(data?.byDate)} />
      </Col>
      <Col xs={24} xl={8}>
        <SummaryCard title="个人汇总" total={data?.totalDays} count={totalCount(data?.byProject)} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="项目工时占比" option={makePieOption(data?.byProject)} />
      </Col>
      <Col xs={24} lg={12}>
        <Card title="项目工时明细" style={{ borderRadius: 8 }}>
          <SummaryTable data={data?.byProject} nameTitle="项目" />
        </Card>
      </Col>
    </Row>
  );
}

function GroupView({ data }: { data: GroupReport | null }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <DataChart title="组内每日趋势" option={makeTrendOption(data?.byDate)} />
      </Col>
      <Col xs={24} xl={8}>
        <SummaryCard title="组别汇总" total={data?.totalDays} count={totalCount(data?.byUser)} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="成员工时排行" option={makeBarOption(data?.byUser, '天', palette[0])} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="项目工时占比" option={makePieOption(data?.byProject)} />
      </Col>
      <Col xs={24}>
        <Card title="成员明细" style={{ borderRadius: 8 }}>
          <SummaryTable data={data?.byUser} nameTitle="成员" />
        </Card>
      </Col>
    </Row>
  );
}

function DepartmentView({ data }: { data: DepartmentReport | null }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <DataChart title="部门每日趋势" option={makeTrendOption(data?.byDate)} />
      </Col>
      <Col xs={24} xl={8}>
        <SummaryCard title="部门汇总" total={data?.totalDays} count={totalCount(data?.byUser)} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="组别工时分布" option={makeBarOption(data?.byGroup, '天', palette[3])} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="项目工时占比" option={makePieOption(data?.byProject)} />
      </Col>
      <Col xs={24} lg={12}>
        <Card title="人员明细" style={{ borderRadius: 8 }}>
          <SummaryTable data={data?.byUser} nameTitle="成员" />
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="组别明细" style={{ borderRadius: 8 }}>
          <SummaryTable data={data?.byGroup} nameTitle="组别" />
        </Card>
      </Col>
    </Row>
  );
}

function ProjectView({ data }: { data: ProjectReport | null }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <DataChart title="项目每日趋势" option={makeTrendOption(data?.byDate)} />
      </Col>
      <Col xs={24} xl={8}>
        <SummaryCard title="项目汇总" total={data?.totalDays} count={totalCount(data?.byUser)} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="部门工时分布" option={makeBarOption(data?.byDepartment, '天', palette[3])} />
      </Col>
      <Col xs={24} lg={12}>
        <DataChart title="组别工时分布" option={makeBarOption(data?.byGroup, '天', palette[1])} />
      </Col>
      <Col xs={24} lg={12}>
        <Card title="成员明细" style={{ borderRadius: 8 }}>
          <SummaryTable data={data?.byUser} nameTitle="成员" />
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="组别明细" style={{ borderRadius: 8 }}>
          <SummaryTable data={data?.byGroup} nameTitle="组别" />
        </Card>
      </Col>
    </Row>
  );
}

function OvertimeView({ data }: { data: OvertimeReport | null }) {
  const typeData = useMemo(() => {
    if (!data?.byType) return {};
    const typeText: Record<string, string> = { weekend: '周末加班', holiday: '节假日加班', weekday: '工作日加班' };
    return Object.fromEntries(Object.entries(data.byType).map(([type, days]) => [typeText[type] || type, days]));
  }, [data]);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={8}>
        <Card title="加班汇总" style={{ borderRadius: 8 }}>
          <Statistic title="总加班" value={data?.totalDays || 0} suffix="天" precision={1} />
          <Divider />
          <Text type="secondary">仅统计已审批通过的加班申请</Text>
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <DataChart title="加班类型占比" option={makePieOption(typeData, '小时')} />
      </Col>
      <Col xs={24} xl={8}>
        <DataChart title="人员加班排行" option={makeBarOption(data?.byUser, '小时', palette[2])} />
      </Col>
    </Row>
  );
}

export default function Report() {
  const [tabKey, setTabKey] = useState<ReportTabKey>('personal');
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().startOf('month'),
    dayjs().endOf('month'),
  ]);
  const [scope, setScope] = useState<ReportScope | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number>();
  const [selectedDept, setSelectedDept] = useState<number>();
  const [selectedDeptGroup, setSelectedDeptGroup] = useState<number>();
  const [selectedProj, setSelectedProj] = useState<number>();
  const [selectedProjDept, setSelectedProjDept] = useState<number>();
  const [selectedProjGroup, setSelectedProjGroup] = useState<number>();
  const [personalData, setPersonalData] = useState<PersonalReport | null>(null);
  const [groupData, setGroupData] = useState<GroupReport | null>(null);
  const [deptData, setDeptData] = useState<DepartmentReport | null>(null);
  const [projData, setProjData] = useState<ProjectReport | null>(null);
  const [overtimeData, setOvertimeData] = useState<OvertimeReport | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 记录已加载过的 Tab，切 Tab 时若未加载则自动加载一次
  const [loadedTabs, setLoadedTabs] = useState<Set<ReportTabKey>>(new Set());

  const startDate = dateRange[0].format('YYYY-MM-DD');
  const endDate = dateRange[1].format('YYYY-MM-DD');
  const groupsForDept = (deptId?: number) => (scope?.groups || []).filter((group) => !deptId || group.departmentId === deptId);
  const selectedProject = (scope?.projects || []).find((project) => project.id === selectedProj);
  const projectModuleGroups = (selectedProject?.moduleSEs || [])
    .map((se) => se.group)
    .filter((group): group is NonNullable<typeof group> => Boolean(group))
    .map((group) => ({
      id: group.id,
      name: group.name,
      departmentId: group.departmentId ?? null,
      department: group.department,
    }));
  const projectDepartments = uniqueById([
    ...(projData?.filters?.departments || []),
    ...projectModuleGroups
      .map((group) => group.department)
      .filter((dept): dept is NonNullable<typeof dept> => Boolean(dept))
      .map((department) => ({ id: department.id, name: department.name })),
  ]);
  const projectGroups = uniqueById([
    ...(projData?.filters?.groups || []),
    ...projectModuleGroups.map((group) => ({ id: group.id, name: group.name, departmentId: group.departmentId ?? null })),
  ])
    .filter((group) => !selectedProjDept || group.departmentId === selectedProjDept);

  const tabItems = useMemo(() => [
    ...(scope?.canViewPersonal ? [{ key: 'personal', label: '个人报表' }] : []),
    ...(scope?.canViewGroup ? [{ key: 'group', label: '组别报表' }] : []),
    ...(scope?.canViewDepartment ? [{ key: 'department', label: '部门报表' }] : []),
    ...(scope?.canViewProject ? [{ key: 'project', label: '项目报表' }] : []),
    ...(scope?.canViewOvertime ? [{ key: 'overtime', label: '加班统计' }] : []),
  ] as { key: ReportTabKey; label: string }[], [scope]);

  const getErrorMessage = (err: any, fallback: string) => err?.response?.data?.message || err?.message || fallback;

  useEffect(() => {
    setScopeLoading(true);
    reportApi.getScope()
      .then((res) => {
        const nextScope = res.data || null;
        setScope(nextScope);
        setSelectedGroup(nextScope?.groups?.[0]?.id);
        setSelectedDept(nextScope?.departments?.[0]?.id);
        setSelectedProj(nextScope?.projects?.[0]?.id);
      })
      .catch((err: any) => {
        setError(getErrorMessage(err, '报表范围加载失败'));
      })
      .finally(() => setScopeLoading(false));
  }, []);

  useEffect(() => {
    if (!scope) return;
    if (!tabItems.some((item) => item.key === tabKey)) {
      const nextKey = tabItems[0]?.key;
      if (nextKey) setTabKey(nextKey);
    }
  }, [scope, tabItems, tabKey]);

  const loadPersonal = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await reportApi.getPersonal(startDate, endDate);
      setPersonalData(res.data || null);
    } catch (err: any) {
      setPersonalData(null);
      setError(getErrorMessage(err, '个人报表加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadGroup = async () => {
    if (!selectedGroup) {
      setError('请选择组别');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await reportApi.getGroup(selectedGroup, startDate, endDate);
      setGroupData(res.data || null);
    } catch (err: any) {
      setGroupData(null);
      setError(getErrorMessage(err, '组别报表加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadDepartment = async () => {
    if (!selectedDept) {
      setError('请选择部门');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await reportApi.getDepartment(selectedDept, startDate, endDate, selectedDeptGroup);
      setDeptData(res.data || null);
    } catch (err: any) {
      setDeptData(null);
      setError(getErrorMessage(err, '部门报表加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadProject = async () => {
    if (!selectedProj) {
      setError('请选择项目');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await reportApi.getProject(selectedProj, startDate, endDate, {
        departmentId: selectedProjDept,
        groupId: selectedProjGroup,
      });
      setProjData(res.data || null);
    } catch (err: any) {
      setProjData(null);
      setError(getErrorMessage(err, '项目报表加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadOvertime = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await reportApi.getOvertime({
        startDate,
        endDate,
        departmentId: selectedDept,
        groupId: selectedDeptGroup,
      });
      setOvertimeData(res.data || null);
    } catch (err: any) {
      setOvertimeData(null);
      setError(getErrorMessage(err, '加班统计加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const queryCurrent = (key: ReportTabKey = tabKey) => {
    // 标记该 Tab 已加载（无论成功失败，避免切回时反复触发）
    setLoadedTabs((prev) => new Set(prev).add(key));
    if (key === 'group') loadGroup();
    else if (key === 'department') loadDepartment();
    else if (key === 'project') loadProject();
    else if (key === 'overtime') loadOvertime();
    else loadPersonal();
  };

  /** 切 Tab 时若该 Tab 未加载过则自动加载 */
  const handleTabChange = (key: string) => {
    const nextKey = key as ReportTabKey;
    setTabKey(nextKey);
    if (!loadedTabs.has(nextKey)) {
      queryCurrent(nextKey);
    }
  };

  /** 日期范围改变时清空已加载标记，强制重新查询 */
  const handleDateChange = (value: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null) => {
    if (value && value[0] && value[1]) {
      setDateRange([value[0], value[1]]);
      setLoadedTabs(new Set());
    }
  };

  const handleExport = async (type: ReportTabKey) => {
    try {
      const params: any = { startDate, endDate };
      if (type === 'group') {
        if (!selectedGroup) { setError('请选择组别'); return; }
        params.groupId = selectedGroup;
      } else if (type === 'department') {
        if (!selectedDept) { setError('请选择部门'); return; }
        params.departmentId = selectedDept;
        params.groupId = selectedDeptGroup;
      } else if (type === 'project') {
        if (!selectedProj) { setError('请选择项目'); return; }
        params.projectId = selectedProj;
        params.departmentId = selectedProjDept;
        params.groupId = selectedProjGroup;
      } else if (type === 'overtime') {
        params.departmentId = selectedDept;
        params.groupId = selectedDeptGroup;
      }
      const res = await request.get(`/reports/export/${type}`, { params, responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res as any]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}-report-${params.startDate}-${params.endDate}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      message.error(getErrorMessage(err, '导出失败'));
    }
  };

  return (
    <div>
      <Title level={4} style={{ fontWeight: 700 }}>报表中心</Title>

      <Card style={{ borderRadius: 8, marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col>
            <DatePicker.RangePicker
              value={dateRange}
              onChange={handleDateChange}
            />
          </Col>
          {tabKey === 'group' && (
            <Col>
              <Select
                placeholder="选择组别"
                style={{ width: 200 }}
                options={(scope?.groups || []).map((group) => ({ label: group.name, value: group.id }))}
                value={selectedGroup}
                onChange={setSelectedGroup}
              />
            </Col>
          )}
          {(tabKey === 'department' || tabKey === 'overtime') && (
            <>
              <Col>
                <Select
                  placeholder="选择部门"
                  style={{ width: 200 }}
                  allowClear={tabKey === 'overtime'}
                  options={(scope?.departments || []).map((department) => ({ label: department.name, value: department.id }))}
                  value={selectedDept}
                  onChange={(value) => {
                    setSelectedDept(value);
                    setSelectedDeptGroup(undefined);
                  }}
                />
              </Col>
              <Col>
                <Select
                  placeholder="按组别过滤"
                  style={{ width: 200 }}
                  allowClear
                  disabled={tabKey === 'department' && !selectedDept}
                  options={groupsForDept(selectedDept).map((group) => ({ label: group.name, value: group.id }))}
                  value={selectedDeptGroup}
                  onChange={setSelectedDeptGroup}
                />
              </Col>
            </>
          )}
          {tabKey === 'project' && (
            <>
              <Col>
                <Select
                  placeholder="选择项目"
                  style={{ width: 220 }}
                  options={(scope?.projects || []).map((project) => ({ label: project.name, value: project.id }))}
                  value={selectedProj}
                  onChange={(value) => {
                    setSelectedProj(value);
                    setSelectedProjDept(undefined);
                    setSelectedProjGroup(undefined);
                    setProjData(null);
                  }}
                />
              </Col>
              <Col>
                <Select
                  placeholder="按部门过滤"
                  style={{ width: 200 }}
                  allowClear
                  options={projectDepartments.map((department) => ({ label: department.name, value: department.id }))}
                  value={selectedProjDept}
                  onChange={(value) => {
                    setSelectedProjDept(value);
                    setSelectedProjGroup(undefined);
                  }}
                />
              </Col>
              <Col>
                <Select
                  placeholder="按组别过滤"
                  style={{ width: 200 }}
                  allowClear
                  options={projectGroups.map((group) => ({ label: group.name, value: group.id }))}
                  value={selectedProjGroup}
                  onChange={setSelectedProjGroup}
                />
              </Col>
            </>
          )}
          <Col>
            <Button type="primary" onClick={() => queryCurrent()} loading={loading}>查询</Button>
          </Col>
          <Col>
            <Button icon={<DownloadOutlined />} onClick={() => handleExport(tabKey)}>
              导出Excel
            </Button>
          </Col>
        </Row>
      </Card>

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

      <Spin spinning={scopeLoading}>
        <Tabs
          activeKey={tabKey}
          items={tabItems}
          onChange={handleTabChange}
          style={{ marginBottom: 12 }}
        />

        <Spin spinning={loading}>
          {tabItems.length === 0 && <Empty description="暂无可查看的报表" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          {tabKey === 'personal' && <PersonalView data={personalData} />}
          {tabKey === 'group' && <GroupView data={groupData} />}
          {tabKey === 'department' && <DepartmentView data={deptData} />}
          {tabKey === 'project' && <ProjectView data={projData} />}
          {tabKey === 'overtime' && <OvertimeView data={overtimeData} />}
        </Spin>
      </Spin>
    </div>
  );
}
