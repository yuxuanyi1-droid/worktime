import { useEffect, useRef, useState } from 'react';
import { Card, Button, Typography, Space, message, Row, Col, Statistic, Divider, List, Tooltip } from 'antd';
import { SendOutlined, SaveOutlined, LeftOutlined, RightOutlined, FileSearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { weeklyReportApi } from '../../api/weeklyReport';
import { timesheetApi } from '../../api/timesheet';
import type { Timesheet, WeeklyReport } from '../../types';
import { Input } from 'antd';
import { usePermission } from '../../hooks/usePermission';

dayjs.extend(isoWeek);

const { Title } = Typography;
const { TextArea } = Input;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function RichTextEditor({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value;
    }
  }, [value]);

  return (
    <div style={{ position: 'relative' }}>
      {!value && (
        <div style={{
          position: 'absolute',
          top: 10,
          left: 12,
          color: '#B0A898',
          pointerEvents: 'none',
          fontSize: 14,
        }}>
          {placeholder}
        </div>
      )}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        }}
        style={{
          minHeight: 330,
          padding: '10px 12px',
          fontSize: 14,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          border: '1px solid #d9d9d9',
          borderRadius: 6,
          background: disabled ? '#f5f5f5' : '#fff',
          color: disabled ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.88)',
          outline: 'none',
          overflowY: 'auto',
        }}
      />
    </div>
  );
}

export default function WeeklyReportPage() {
  const [weekStart, setWeekStart] = useState(dayjs().isoWeekday(1)); // 周一
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [weekHours, setWeekHours] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const { hasPermission } = usePermission();

  const canCreate = hasPermission('weekly_report:create');
  const canViewSelf = hasPermission('weekly_report:view:self');
  const canUpdate = canCreate;
  const canSubmit = hasPermission('weekly_report:submit:self');

  useEffect(() => {
    loadData();
  }, [weekStart]);

  const loadData = async () => {
    if (!canViewSelf) {
      setReport(null);
      setContent('');
      setSummary('');
      setWeekHours(null);
      return;
    }
    const ws = weekStart.format('YYYY-MM-DD');
    const we = weekStart.add(6, 'day').format('YYYY-MM-DD');
    try {
      const res = await weeklyReportApi.getByWeek(ws);
      if (res.data) {
        setReport(res.data);
        setContent(res.data.content || '');
        setSummary(res.data.summary || '');
      } else {
        setReport(null);
        setContent('');
        setSummary('');
      }
      // 加载本周工时
      const hoursRes = await timesheetApi.getWeeklySummary(ws, we);
      if (hoursRes.data) setWeekHours(hoursRes.data);
    } catch (e: any) {
      message.error(e?.response?.data?.message || '周报数据加载失败');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const ws = weekStart.format('YYYY-MM-DD');
      const we = weekStart.add(6, 'day').format('YYYY-MM-DD');
      await weeklyReportApi.save({
        weekStart: ws,
        weekEnd: we,
        content,
        summary,
        totalDays: weekHours?.totalDays || 0,
      });
      message.success('保存成功');
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败');
    }
    setSaving(false);
  };

  const handleSubmit = async () => {
    if (!report?.id) {
      message.warning('请先保存周报');
      return;
    }
    try {
      await weeklyReportApi.submit(report.id);
      message.success('提交成功');
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.message || '提交失败');
    }
  };

  const getErrorMessage = (error: unknown, fallback: string) => {
    const e = error as { response?: { data?: { message?: string } }; message?: string };
    return e?.response?.data?.message || e?.message || fallback;
  };

  const prevWeek = () => setWeekStart(prev => prev.subtract(7, 'day'));
  const nextWeek = () => setWeekStart(prev => prev.add(7, 'day'));
  const goThisWeek = () => setWeekStart(dayjs().isoWeekday(1));

  const handleFillFromTimesheet = async () => {
    if (!isEditable || !canUpdate) return;

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
        .map(([projectName, descriptions]) => `<strong>项目：</strong> ${escapeHtml(projectName)}<br /><strong>工作内容：</strong> ${descriptions.map(escapeHtml).join('<br />')}`)
        .join('\n\n');
      setContent(generated);
      message.success('已从当前周工时生成摘要');
    } catch (error) {
      message.error(getErrorMessage(error, '工时摘要生成失败'));
    }
  };

  // 如果周报已提交或已审批，禁用编辑
  const isEditable = !report || report.status === 'draft' || report.status === 'rejected';

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>周报管理</Title>

      <Card style={{ borderRadius: 12, marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <Button icon={<LeftOutlined />} onClick={prevWeek} size="small" />
              <span style={{ fontWeight: 600, fontSize: 15 }}>
                {weekStart.format('YYYY年M月D日')} — {weekStart.add(6, 'day').format('M月D日')}
              </span>
              <Button icon={<RightOutlined />} onClick={nextWeek} size="small" />
              <Button size="small" onClick={goThisWeek}>本周</Button>
              <Tooltip title="从当前周工时的工作内容生成周报内容">
                <Button
                  size="small"
                  icon={<FileSearchOutlined />}
                  onClick={handleFillFromTimesheet}
                  disabled={!isEditable || !canUpdate}
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
                <Button type="primary" icon={<SendOutlined />} onClick={handleSubmit}
                  disabled={report?.status === 'submitted' || report?.status === 'approved'}>
                  提交审批
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={16}>
          <Card title="周报内容" style={{ borderRadius: 12 }}>
            <RichTextEditor
              value={content}
              onChange={setContent}
              disabled={!isEditable || !canUpdate}
              placeholder="请编写本周工作总结..."
            />
            <Divider />
            <Title level={5}>工作摘要</Title>
            <TextArea
              value={summary}
              onChange={(e: any) => setSummary(e.target.value)}
              rows={3}
              placeholder="简要概述本周工作..."
              disabled={!isEditable || !canUpdate}
            />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="本周工时汇总" style={{ borderRadius: 12, marginBottom: 16 }}>
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
    </div>
  );
}
