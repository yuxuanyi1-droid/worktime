import { useEffect, useRef, useState } from 'react';
import { Alert, Card, Button, Typography, Space, message, Row, Col, Statistic, Divider, List, Tooltip, Modal, Tag, Spin } from 'antd';
import { SendOutlined, SaveOutlined, LeftOutlined, RightOutlined, FileSearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { weeklyReportApi } from '../../api/weeklyReport';
import { timesheetApi } from '../../api/timesheet';
import type { Timesheet, WeeklyReport } from '../../types';
import { Input } from 'antd';
import { usePermission } from '../../hooks/usePermission';
import { weeklyReportContentToText } from '../../utils/weeklyReportContent';

dayjs.extend(isoWeek);

const { Title } = Typography;
const { TextArea } = Input;

export default function WeeklyReportPage() {
  const [weekStart, setWeekStart] = useState(dayjs().isoWeekday(1)); // 周一
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [weekHours, setWeekHours] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const loadRequestId = useRef(0);
  const activeWeek = useRef(weekStart.format('YYYY-MM-DD'));
  activeWeek.current = weekStart.format('YYYY-MM-DD');
  const { hasPermission, hasAnyPermission } = usePermission();

  const canCreate = hasPermission('weekly_report:create');
  const canViewSelf = hasPermission('weekly_report:view:self');
  const canUpdate = canCreate;
  const canSubmit = hasPermission('weekly_report:submit:self');
  const canViewTimesheet = hasAnyPermission(
    'timesheet:view:self',
    'timesheet:view:group',
    'timesheet:view:department',
  );

  useEffect(() => {
    loadData();
  }, [weekStart]);

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnUnsaved);
    return () => window.removeEventListener('beforeunload', warnUnsaved);
  }, [dirty]);

  const loadData = async () => {
    if (!canViewSelf) {
      setReport(null);
      setContent('');
      setSummary('');
      setWeekHours(null);
      return;
    }
    const requestId = ++loadRequestId.current;
    const ws = weekStart.format('YYYY-MM-DD');
    const we = weekStart.add(6, 'day').format('YYYY-MM-DD');
    setLoading(true);
    setLoadError(null);
    setHoursError(null);
    setReport(null);
    setContent('');
    setSummary('');
    setWeekHours(null);
    try {
      const res = await weeklyReportApi.getByWeek(ws);
      if (requestId !== loadRequestId.current) return;
      if (res.data) {
        setReport(res.data);
        setContent(weeklyReportContentToText(res.data.content));
        setSummary(res.data.summary || '');
      } else {
        setReport(null);
        setContent('');
        setSummary('');
      }
      setDirty(false);
    } catch (e: any) {
      if (requestId === loadRequestId.current) {
        setLoadError(e?.response?.data?.message || '周报数据加载失败');
      }
    }

    if (requestId === loadRequestId.current && canViewTimesheet) {
      try {
        const hoursRes = await timesheetApi.getWeeklySummary(ws, we);
        if (requestId === loadRequestId.current && hoursRes.data) setWeekHours(hoursRes.data);
      } catch (e: any) {
        if (requestId === loadRequestId.current) {
          setHoursError(e?.response?.data?.message || '本周工时汇总加载失败');
          setWeekHours(null);
        }
      }
    }
    if (requestId === loadRequestId.current) setLoading(false);
  };

  const saveDraft = async () => {
    const ws = weekStart.format('YYYY-MM-DD');
    const we = weekStart.add(6, 'day').format('YYYY-MM-DD');
    const response = await weeklyReportApi.save({
      weekStart: ws,
      weekEnd: we,
      content,
      summary,
    });
    if (response.data && activeWeek.current === ws) setReport(response.data);
    setDirty(false);
    return response.data;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveDraft();
      message.success('保存成功');
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败');
    }
    setSaving(false);
  };

  const handleSubmit = async () => {
    const submittedContent = canUpdate ? content : weeklyReportContentToText(report?.content);
    if (!submittedContent.trim()) {
      message.warning('请填写周报内容后再提交');
      return;
    }
    setSubmitting(true);
    try {
      // 先保存当前编辑内容，避免用户点击提交时仍送出上一次保存的旧版本。
      const saved = canUpdate ? await saveDraft() : report;
      if (!saved?.id) throw new Error('周报保存结果缺少记录标识');
      await weeklyReportApi.submit(saved.id);
      message.success('提交成功');
      await loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const getErrorMessage = (error: unknown, fallback: string) => {
    const e = error as { response?: { data?: { message?: string } }; message?: string };
    return e?.response?.data?.message || e?.message || fallback;
  };

  const changeWeek = (next: dayjs.Dayjs) => {
    if (!dirty) {
      setWeekStart(next);
      return;
    }
    Modal.confirm({
      title: '放弃未保存的修改？',
      content: '切换周次后，当前编辑内容将不会保留。',
      okText: '放弃并切换',
      cancelText: '继续编辑',
      onOk: () => {
        setDirty(false);
        setWeekStart(next);
      },
    });
  };
  const prevWeek = () => changeWeek(weekStart.subtract(7, 'day'));
  const nextWeek = () => changeWeek(weekStart.add(7, 'day'));
  const goThisWeek = () => changeWeek(dayjs().isoWeekday(1));

  const handleFillFromTimesheet = async () => {
    if (!isEditable || !canUpdate || !canViewTimesheet) return;

    const ws = weekStart.format('YYYY-MM-DD');
    const we = weekStart.add(6, 'day').format('YYYY-MM-DD');
    try {
      const res = await timesheetApi.getMy({ startDate: ws, endDate: we, pageSize: 200 });
      const records = (res.data?.list || []) as Timesheet[];
      const projectMap = new Map<string, string[]>();

      for (const record of records) {
        const description = record.description?.trim();
        if (!description) continue;
        const projectName = record.project?.name || '未分配项目';
        const list = projectMap.get(projectName) || [];
        if (!list.includes(description)) list.push(description);
        projectMap.set(projectName, list);
      }

      if (!projectMap.size) {
        message.info('当前周工时没有可提取的工作内容');
        return;
      }

      const generated = Array.from(projectMap.entries())
        .map(([projectName, descriptions]) => `项目：${projectName}\n工作内容：\n${descriptions.map((item) => `- ${item}`).join('\n')}`)
        .join('\n\n');
      setContent(generated);
      setDirty(true);
      message.success('已从当前周工时生成摘要');
    } catch (error) {
      message.error(getErrorMessage(error, '工时摘要生成失败'));
    }
  };

  // 如果周报已提交或已审批，禁用编辑
  const isEditable = !loading && !loadError
    && (!report || ['draft', 'rejected', 'withdrawn'].includes(report.status));

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>周报管理</Title>

      <Card style={{ borderRadius: 12, marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <Button aria-label="上一周" icon={<LeftOutlined />} onClick={prevWeek} size="small" disabled={saving || submitting} />
              <span style={{ fontWeight: 600, fontSize: 15 }}>
                {weekStart.format('YYYY年M月D日')} — {weekStart.add(6, 'day').format('M月D日')}
              </span>
              {report && <Tag color={report.status === 'approved' ? 'green' : report.status === 'submitted' ? 'blue' : report.status === 'rejected' ? 'red' : 'default'}>
                {{ draft: '草稿', submitted: '审批中', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' }[report.status]}
              </Tag>}
              <Button aria-label="下一周" icon={<RightOutlined />} onClick={nextWeek} size="small" disabled={saving || submitting} />
              <Button size="small" onClick={goThisWeek} disabled={saving || submitting}>本周</Button>
              <Tooltip title={canViewTimesheet ? '从当前周工时的工作内容生成周报内容' : '缺少本人工时查看权限'}>
                <Button
                  size="small"
                  icon={<FileSearchOutlined />}
                  onClick={handleFillFromTimesheet}
                  disabled={!isEditable || !canUpdate || !canViewTimesheet}
                >
                  工时摘要
                </Button>
              </Tooltip>
            </Space>
          </Col>
          <Col>
            <Space>
              {canUpdate && isEditable && (
                <Button icon={<SaveOutlined />} onClick={handleSave} loading={saving}>保存草稿</Button>
              )}
              {canSubmit && (
                <Button type="primary" icon={<SendOutlined />} onClick={handleSubmit} loading={submitting}
                  disabled={loading || !!loadError || report?.status === 'submitted' || report?.status === 'approved' || (!canUpdate && !report)}>
                  提交审批
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {loadError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={loadError}
          action={<Button size="small" onClick={() => void loadData()}>重试</Button>}
        />
      )}

      <Spin spinning={loading}>
      <Row gutter={16}>
        <Col xs={24} lg={16}>
          <Card title="周报内容" style={{ borderRadius: 12 }}>
            <TextArea
              value={content}
              onChange={(event) => { setContent(event.target.value); setDirty(true); }}
              disabled={!isEditable || !canUpdate}
              placeholder="请编写本周工作总结..."
              autoSize={{ minRows: 14, maxRows: 24 }}
            />
            <Divider />
            <Title level={5}>工作摘要</Title>
            <TextArea
              value={summary}
              onChange={(e: any) => { setSummary(e.target.value); setDirty(true); }}
              rows={3}
              placeholder="简要概述本周工作..."
              disabled={!isEditable || !canUpdate}
            />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="本周工时汇总" style={{ borderRadius: 12, marginBottom: 16 }}>
            {hoursError && (
              <Alert type="warning" showIcon message={hoursError} style={{ marginBottom: 12 }} />
            )}
            {!canViewTimesheet && (
              <Alert type="info" showIcon message="当前角色没有工时查看权限，无法展示工时汇总" style={{ marginBottom: 12 }} />
            )}
            <Statistic title="总工时" value={weekHours?.totalDays || 0} suffix="天" />
            <Divider />
            <Title level={5}>项目分布</Title>
            <List
              size="small"
              dataSource={weekHours?.byProject ? Object.entries(weekHours.byProject) : []}
              renderItem={([name, val]: [string, any]) => (
                <List.Item>
                  <span>{name}</span>
                  <span>{val?.days ?? val}天</span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
      </Spin>
    </div>
  );
}
