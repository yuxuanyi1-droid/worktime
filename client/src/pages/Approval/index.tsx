import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Space, Tag, Tabs, Input, message, Typography, Select, Steps,
  Descriptions, Modal, Spin, Tooltip, Popconfirm, DatePicker,
} from 'antd';
import {
  CheckOutlined, CloseOutlined, EyeOutlined, ClockCircleOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, UserOutlined,
  LinkOutlined, CopyOutlined, ArrowLeftOutlined, RollbackOutlined, SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);
import { approvalApi, MySubmission, ApprovalDetail } from '../../api/approval';
import { ApprovalItem, ApprovalRecord, statusMap, stepTypeMap } from '../../types';
import { useNavigate, useParams } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const typeLabels: Record<string, string> = {
  timesheet: '工时',
  overtime: '加班',
  weekly_report: '周报',
};

const overtimeTypeLabels: Record<string, string> = {
  weekday: '工作日加班',
  weekend: '周末加班',
  holiday: '节假日加班',
};

const statusOptions = [
  { label: '全部', value: '' },
  { label: '审批中', value: 'submitted' },
  { label: '已通过', value: 'approved' },
  { label: '已驳回', value: 'rejected' },
];

function getErrorMessage(error: unknown, fallback: string) {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
}

function sanitizeWeeklyHtml(value?: string) {
  if (!value) return '';
  return value
    .replace(/<(?!\/?(strong|b|br)\b)[^>]*>/gi, '')
    .replace(/<(strong|b)\b[^>]*>/gi, '<strong>')
    .replace(/<\/(strong|b)>/gi, '</strong>')
    .replace(/<br\s*\/?>/gi, '<br />');
}

function RichTextValue({ value }: { value?: string }) {
  if (!value) return <span>-</span>;
  return (
    <div
      style={{ whiteSpace: 'pre-wrap' }}
      dangerouslySetInnerHTML={{ __html: sanitizeWeeklyHtml(value) }}
    />
  );
}

/** 生成审批详情分享链接 */
export function getApprovalShareUrl(targetType: string, targetId: number) {
  return `${window.location.origin}/approval/detail/${targetType}/${targetId}`;
}

// ==================== 审批详情视图（共用） ====================
function ApprovalDetailView({
  detail, loading, showActions, onApprove, onActionLoading,
}: {
  detail: ApprovalDetail | null;
  loading: boolean;
  showActions?: boolean;
  onApprove?: (action: 'approve' | 'reject', comment: string) => void;
  onActionLoading?: boolean;
}) {
  const stepStatusIcon = (status: string) => {
    switch (status) {
      case 'approved': return <CheckCircleOutlined style={{ color: '#4A8B5E' }} />;
      case 'rejected': return <CloseCircleOutlined style={{ color: '#C0564B' }} />;
      case 'current': return <SyncOutlined spin style={{ color: '#6B8F71' }} />;
      default: return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />;
    }
  };

  const renderContent = () => {
    if (!detail) return null;
    const c = detail.content;

    return (
      <Descriptions column={2} bordered size="small" style={{ marginBottom: 24 }}>
        <Descriptions.Item label="申请人">
          <Space>
            <UserOutlined />
            <span>{c.applicant?.name || '-'}</span>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="所属部门/组">
          {c.applicant?.department || '-'} / {c.applicant?.group || '-'}
        </Descriptions.Item>

        {c.targetType === 'timesheet' && (
          <>
            <Descriptions.Item label="项目">{c.project?.name || '-'}</Descriptions.Item>
            {c.weekEntries && c.weekEntries.length > 0 ? (
              <Descriptions.Item label="工时明细" span={3}>
                <div style={{ marginBottom: 8 }}>
                  {c.weekStart && c.weekEnd && (
                    <Text type="secondary">{c.weekStart} ~ {c.weekEnd}</Text>
                  )}
                </div>
                <Table
                  size="small"
                  bordered
                  pagination={false}
                  dataSource={c.weekEntries.map((e, i) => ({
                    key: e.date,
                    dayLabel: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][dayjs(e.date).isoWeekday() - 1],
                    date: e.date,
                    hours: e.hours,
                  }))}
                  columns={[
                    { title: '', dataIndex: 'dayLabel', width: 60, align: 'center' as const },
                    { title: '日期', dataIndex: 'date', width: 100, align: 'center' as const,
                      render: (d: string) => dayjs(d).format('M/D'),
                    },
                    { title: '工时(天)', dataIndex: 'hours', width: 80, align: 'center' as const,
                      render: (h: number) => <Text strong style={{ color: '#6B8F71' }}>{h}</Text>,
                    },
                  ]}
                />
                <div style={{ marginTop: 8 }}>
                  合计：<Text strong style={{ color: '#6B8F71', fontSize: 15 }}>{c.hours}</Text> 天
                </div>
              </Descriptions.Item>
            ) : (
              <>
                <Descriptions.Item label="日期">{c.date || '-'}</Descriptions.Item>
                <Descriptions.Item label="工时">
                  <Text strong style={{ color: '#6B8F71' }}>{c.hours}天</Text>
                </Descriptions.Item>
              </>
            )}
            <Descriptions.Item label="工作内容" span={c.weekEntries ? 3 : 1}><span style={{ whiteSpace: 'pre-wrap' }}>{c.description || '-'}</span></Descriptions.Item>
            {c.previousApproval && (
              <Descriptions.Item label="原审批" span={c.weekEntries ? 3 : 2}>
                <Button
                  type="link"
                  size="small"
                  icon={<LinkOutlined />}
                  onClick={() => window.open(`/approval/detail/timesheet/${c.previousApproval!.targetId}`, '_blank')}
                >
                  查看原审批单
                </Button>
                <Text type="secondary" style={{ marginLeft: 8 }}>（此工时为修改后重新提交）</Text>
              </Descriptions.Item>
            )}
          </>
        )}

        {c.targetType === 'overtime' && (
          <>
            <Descriptions.Item label="日期">{c.date || '-'}</Descriptions.Item>
            <Descriptions.Item label="加班时长">
              <Text strong style={{ color: '#C0564B' }}>{c.hours}小时</Text>
            </Descriptions.Item>
            <Descriptions.Item label="加班项目">{c.project?.name || '-'}</Descriptions.Item>
            <Descriptions.Item label="加班类型">{overtimeTypeLabels[c.overtimeType || ''] || c.overtimeType || '-'}</Descriptions.Item>
            <Descriptions.Item label="加班原因">{c.reason || '-'}</Descriptions.Item>
          </>
        )}

        {c.targetType === 'weekly_report' && (
          <>
            <Descriptions.Item label="周次">{c.weekStart} ~ {c.weekEnd}</Descriptions.Item>
            <Descriptions.Item label="总工时">
              <Text strong style={{ color: '#6B8F71' }}>{c.totalHours}天</Text>
            </Descriptions.Item>
            <Descriptions.Item label="周报内容" span={2}>
              <RichTextValue value={c.content} />
            </Descriptions.Item>
            <Descriptions.Item label="工作摘要" span={2}>{c.summary || '-'}</Descriptions.Item>
          </>
        )}

        <Descriptions.Item label="提交时间">{c.createdAt ? new Date(c.createdAt).toLocaleString() : '-'}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusMap[c.status]?.color}>{statusMap[c.status]?.label}</Tag>
          {c.totalSteps > 0 && c.status === 'submitted' && (
            <Text type="secondary" style={{ marginLeft: 8 }}>步骤 {c.currentStep}/{c.totalSteps}</Text>
          )}
        </Descriptions.Item>
      </Descriptions>
    );
  };

  const renderFlowSteps = () => {
    if (!detail) return <Text type="secondary">无审批流程信息</Text>;
    if (!detail.flowSteps.length && !detail.records.length) return <Text type="secondary">无审批流程信息</Text>;

    const ccRecords = detail.records.filter(r => r.action === 'cc');
    const withdrawRecords = detail.records.filter(r => r.action === 'withdraw');

    const stepItems = detail.flowSteps.map((step) => {
      let status: 'wait' | 'process' | 'finish' | 'error' = 'wait';
      if (step.status === 'approved') status = 'finish';
      else if (step.status === 'rejected') status = 'error';
      else if (step.status === 'current') status = 'process';

      const icon = stepStatusIcon(step.status);

      const title = (
        <span>
          {step.label || stepTypeMap[step.stepType] || `步骤${step.stepOrder}`}
          {step.status === 'current' && <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>当前步骤</Tag>}
          {step.status === 'approved' && step.action === 'auto' && <Tag color="cyan" style={{ marginLeft: 8, fontSize: 11 }}>自动通过</Tag>}
          {step.status === 'approved' && step.action !== 'auto' && <Tag color="green" style={{ marginLeft: 8, fontSize: 11 }}>已通过</Tag>}
          {step.status === 'rejected' && <Tag color="red" style={{ marginLeft: 8, fontSize: 11 }}>已驳回</Tag>}
        </span>
      );

      const description = (
        <div>
          <div>
            <UserOutlined style={{ marginRight: 4 }} />
            审批人：{step.approverNames?.length ? step.approverNames.join('、') : (step.approverName || '未指定')}
          </div>
          {step.status === 'approved' && step.approvedAt && (
            <div style={{ color: '#4A8B5E', fontSize: 12 }}>
              <CheckCircleOutlined style={{ marginRight: 4 }} />
              通过于 {new Date(step.approvedAt).toLocaleString()}
              {step.comment && <span style={{ marginLeft: 8 }}>意见: {step.comment}</span>}
            </div>
          )}
          {step.status === 'rejected' && step.approvedAt && (
            <div style={{ color: '#C0564B', fontSize: 12 }}>
              <CloseCircleOutlined style={{ marginRight: 4 }} />
              驳回于 {new Date(step.approvedAt).toLocaleString()}
              {step.comment && <span style={{ marginLeft: 8 }}>原因: {step.comment}</span>}
            </div>
          )}
          {step.status === 'current' && (
            <div style={{ color: '#6B8F71', fontSize: 12 }}>
              <SyncOutlined spin style={{ marginRight: 4 }} />
              等待审批中...
            </div>
          )}
        </div>
      );

      return { title, description, status, icon };
    });

    // 追加撤回记录
    const withdrawItems = withdrawRecords.map((wr) => ({
      title: (
        <span>
          <RollbackOutlined style={{ marginRight: 4, color: '#fa8c16' }} />
          撤回
          <Tag color="orange" style={{ marginLeft: 8, fontSize: 11 }}>已撤回</Tag>
        </span>
      ),
      description: (
        <div>
          <div>
            <UserOutlined style={{ marginRight: 4 }} />
            撤回人：{wr.approverName}
          </div>
          <div style={{ color: '#fa8c16', fontSize: 12 }}>
            <RollbackOutlined style={{ marginRight: 4 }} />
            {wr.comment || '申请人撤回'} · {new Date(wr.createdAt).toLocaleString()}
          </div>
        </div>
      ),
      status: 'finish' as const,
      icon: <RollbackOutlined style={{ color: '#fa8c16' }} />,
    }));

    // 追加抄送记录（合并为一条）
    const ccItem = ccRecords.length > 0 ? [{
      title: (
        <span>
          <SendOutlined style={{ marginRight: 4, color: '#722ed1' }} />
          抄送传阅
          <Tag color="purple" style={{ marginLeft: 8, fontSize: 11 }}>抄送</Tag>
        </span>
      ),
      description: (
        <div>
          <div>
            <UserOutlined style={{ marginRight: 4 }} />
            被抄送人：{ccRecords.map(r => r.approverName).join('、')}
          </div>
          <div style={{ color: '#722ed1', fontSize: 12 }}>
            <SendOutlined style={{ marginRight: 4 }} />
            {ccRecords[ccRecords.length - 1].comment} · {new Date(ccRecords[ccRecords.length - 1].createdAt).toLocaleString()}
          </div>
        </div>
      ),
      status: 'finish' as const,
      icon: <SendOutlined style={{ color: '#722ed1' }} />,
    }] : [];

    return (
      <Steps
        direction="vertical"
        size="small"
        current={-1}
        items={[...stepItems, ...withdrawItems, ...ccItem]}
      />
    );
  };

  return (
    <Spin spinning={loading}>
      {detail && (
        <>
          {/* 提交内容 */}
          <Card title={
            <Space>
              <Tag color="blue">{typeLabels[detail.content.targetType] || detail.content.targetType}</Tag>
              <span>申请详情</span>
            </Space>
          } size="small" style={{ marginBottom: 16 }}>
            {renderContent()}
          </Card>

          {/* 审批流程 */}
          <Card title="审批流程" size="small" style={{ marginBottom: showActions ? 16 : 0 }}>
            {renderFlowSteps()}
          </Card>
        </>
      )}
    </Spin>
  );
}

// ==================== 审批详情 Modal（列表页用） ====================
function ApprovalDetailModal({ targetType, targetId, open, onClose }: {
  targetType: string; targetId: number; open: boolean; onClose: () => void;
}) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && targetType && targetId) loadDetail();
  }, [open, targetType, targetId]);

  const loadDetail = async () => {
    setLoading(true);
    try {
      const res = await approvalApi.getDetail(targetType, targetId);
      if (res.data) setDetail(res.data);
    } catch (error) {
      message.error(getErrorMessage(error, '审批详情加载失败'));
      setDetail(null);
    }
    setLoading(false);
  };

  const shareUrl = targetType && targetId ? getApprovalShareUrl(targetType, targetId) : '';

  return (
    <Modal
      title={
        <Space>
          <span>审批详情</span>
          {shareUrl && (
            <Tooltip title="复制分享链接">
              <Button size="small" type="text" icon={<LinkOutlined />}
                onClick={() => { navigator.clipboard.writeText(shareUrl); message.success('链接已复制到剪贴板'); }} />
            </Tooltip>
          )}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
    >
      <ApprovalDetailView detail={detail} loading={loading} />
    </Modal>
  );
}

// ==================== 独立审批详情页（可通过链接直接访问） ====================
export function ApprovalDetailPage() {
  const { targetType, targetId } = useParams<{ targetType: string; targetId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [ccModalOpen, setCcModalOpen] = useState(false);
  const [ccUsers, setCcUsers] = useState<any[]>([]);
  const [allUsers, setAllUsers] = useState<{ id: number; realName: string; department: string | null }[]>([]);

  useEffect(() => {
    if (targetType && targetId) loadDetail();
  }, [targetType, targetId]);

  const loadDetail = async () => {
    setLoading(true);
    try {
      const res = await approvalApi.getDetail(targetType!, Number(targetId));
      if (res.data) setDetail(res.data);
    } catch (error) {
      message.error(getErrorMessage(error, '审批详情加载失败'));
      setDetail(null);
    }
    setLoading(false);
  };

  const handleApprove = async (action: 'approve' | 'reject') => {
    setActionLoading(true);
    try {
      await approvalApi.approve([{
        targetType: targetType!,
        targetId: Number(targetId),
        action,
        comment,
      }]);
      message.success(action === 'approve' ? '审批通过' : '已驳回');
      setComment('');
      loadDetail();
    } catch (error) {
      message.error(getErrorMessage(error, action === 'approve' ? '审批通过失败' : '审批驳回失败'));
    }
    setActionLoading(false);
  };

  const handleWithdraw = async () => {
    setActionLoading(true);
    try {
      await approvalApi.withdraw(targetType!, Number(targetId));
      message.success('已撤回');
      loadDetail();
    } catch (error) {
      message.error(getErrorMessage(error, '撤回失败'));
    }
    setActionLoading(false);
  };

  const handleOpenCc = async () => {
    setCcModalOpen(true);
    if (allUsers.length === 0) {
      try {
        const res = await approvalApi.getUsers();
        if (res.data) setAllUsers(res.data);
      } catch (error) {
        message.error(getErrorMessage(error, '抄送人列表加载失败'));
      }
    }
  };

  const handleCcSubmit = async () => {
    if (ccUsers.length === 0) return message.warning('请选择抄送人');
    setActionLoading(true);
    try {
      await approvalApi.cc(targetType!, Number(targetId), ccUsers.map(u => u.id));
      message.success(`已抄送给 ${ccUsers.map(u => u.realName).join('、')}`);
      setCcUsers([]);
      setCcModalOpen(false);
      loadDetail();
    } catch (error) {
      message.error(getErrorMessage(error, '抄送失败'));
    }
    setActionLoading(false);
  };

  const shareUrl = targetType && targetId ? getApprovalShareUrl(targetType, Number(targetId)) : '';
  const isSubmitted = detail?.content.status === 'submitted';
  const ctx = detail?.viewerContext;
  const currentStep = detail?.flowSteps.find(s => s.status === 'current');

  // 判断角色
  const isApplicant = ctx?.isApplicant;
  const isCurrentApprover = ctx?.isCurrentApprover;
  const isAdmin = ctx?.isAdmin;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>返回</Button>
        <Space>
          <Text type="secondary" copyable={{ text: shareUrl, tooltips: ['复制链接', '已复制'] }}>
            <LinkOutlined /> 分享链接
          </Text>
        </Space>
      </div>

      <ApprovalDetailView detail={detail} loading={loading} />

      {/* === 审批操作区：当前步骤审批人或系统管理员可见 === */}
      {isSubmitted && (isCurrentApprover || isAdmin) && (
        <Card title={isAdmin && !isCurrentApprover ? '管理员审批操作' : '审批操作'} size="small" style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              当前步骤：<Tag color="blue">{currentStep?.label}</Tag>
              审批人：<Tag color="purple">{currentStep?.approverNames?.length ? currentStep.approverNames.join('、') : (currentStep?.approverName || '-')}</Tag>
            </Text>
            {isAdmin && !isCurrentApprover && (
              <div style={{ marginTop: 4 }}>
                <Tag color="orange">您以系统管理员身份审批此步骤</Tag>
              </div>
            )}
          </div>
          <TextArea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="审批意见（可选）"
            rows={2}
            style={{ marginBottom: 12 }}
          />
          <Space>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={actionLoading}
              onClick={() => handleApprove('approve')}
            >
              通过
            </Button>
            <Button
              danger
              icon={<CloseOutlined />}
              loading={actionLoading}
              onClick={() => handleApprove('reject')}
            >
              驳回
            </Button>
          </Space>
        </Card>
      )}

      {/* === 提交人操作区：撤回 + 抄送 === */}
      {isSubmitted && isApplicant && !isCurrentApprover && !isAdmin && (
        <Card title="操作" size="small" style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              当前步骤：<Tag color="blue">{currentStep?.label || '-'}</Tag>
              审批人：<Tag color="purple">{currentStep?.approverNames?.length ? currentStep.approverNames.join('、') : (currentStep?.approverName || '-')}</Tag>
            </Text>
          </div>
          <Space>
            <Popconfirm title="确定撤回此申请？" onConfirm={handleWithdraw}>
              <Button icon={<RollbackOutlined />} loading={actionLoading}>撤回</Button>
            </Popconfirm>
            <Button icon={<SendOutlined />} onClick={handleOpenCc}>抄送传阅</Button>
          </Space>
        </Card>
      )}

      {/* === 已完成/已驳回状态提示 === */}
      {detail && !isSubmitted && (
        <Card size="small" style={{ marginTop: 16 }}>
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            {detail.content.status === 'approved' && (
            <Text style={{ fontSize: 16, color: '#4A8B5E' }}>
              <CheckCircleOutlined style={{ marginRight: 8 }} />
                该申请已审批通过
              </Text>
            )}
            {detail.content.status === 'rejected' && (
              <Text style={{ fontSize: 16, color: '#C0564B' }}>
                <CloseCircleOutlined style={{ marginRight: 8 }} />
                该申请已被驳回
              </Text>
            )}
            {detail.content.status === 'draft' && (
              <Text type="secondary">该申请已撤回，尚未提交审批</Text>
            )}
          </div>
        </Card>
      )}

      {/* 抄送选择弹窗 */}
      <Modal
        title="选择抄送人"
        open={ccModalOpen}
        onCancel={() => { setCcModalOpen(false); setCcUsers([]); }}
        onOk={handleCcSubmit}
        confirmLoading={actionLoading}
        width={500}
      >
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          placeholder="搜索并选择要抄送的人员"
          value={ccUsers.map(u => u.id)}
          onChange={(ids) => {
            setCcUsers(allUsers.filter(u => ids.includes(u.id)));
          }}
          options={allUsers.map(u => ({
            label: `${u.realName}（${u.department || ''}）`,
            value: u.id,
          }))}
          showSearch
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      </Modal>
    </div>
  );
}

/** 我的申请 Tab */
function MySubmissionsTab() {
  const [data, setData] = useState<MySubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
  const [detailTarget, setDetailTarget] = useState<{ targetType: string; targetId: number } | null>(null);
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, [statusFilter, typeFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await approvalApi.getMySubmissions({
        pageSize: 100,
        status: statusFilter || undefined,
        targetType: typeFilter || undefined,
      });
      if (res.data) {
        let list = res.data.list;
        // 前端日期筛选（API 不支持日期参数）
        if (dateRange) {
          list = list.filter((item: any) => {
            const d = item.createdAt ? new Date(item.createdAt) : null;
            if (!d) return false;
            return d >= dateRange[0].toDate() && d <= dateRange[1].endOf('day').toDate();
          });
        }
        setData(list);
      }
    } catch (error) {
      message.error(getErrorMessage(error, '我的申请加载失败'));
      setData([]);
    }
    setLoading(false);
  };

  const renderProgress = (record: any) => {
    const totalSteps = record.totalSteps || 0;
    const currentStep = record.currentStep || 0;
    if (totalSteps === 0) return '-';

    if (record.status === 'approved') return <Tag color="green">已完成全部 {totalSteps} 步审批</Tag>;
    if (record.status === 'rejected') return <Tag color="red">审批被驳回（第 {currentStep} 步）</Tag>;
    if (record.status === 'submitted') return <Tag color="blue">审批中 ({currentStep}/{totalSteps})</Tag>;
    return '-';
  };

  const columns = [
    {
      title: '类型', dataIndex: 'targetType', key: 'type', width: 80,
      render: (t: string) => <Tag color="blue">{typeLabels[t] || t}</Tag>,
    },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '工时(天)', dataIndex: 'hours', key: 'hours', width: 80,
      render: (h: number | undefined) => h ? `${h}天` : '-',
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label}</Tag>,
    },
    {
      title: '审批进度', key: 'progress', width: 160,
      render: (_: any, r: any) => renderProgress(r),
    },
    {
      title: '提交时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
      render: (t: string) => t ? new Date(t).toLocaleString() : '-',
    },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: any, r: any) => (
        <Button type="link" size="small" onClick={() => navigate(`/approval/detail/${r.targetType}/${r.targetId}`)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
        <Select placeholder="类型筛选" allowClear style={{ width: 140 }}
          options={[{ label: '工时', value: 'timesheet' }, { label: '加班', value: 'overtime' }, { label: '周报', value: 'weekly_report' }]}
          onChange={(v) => setTypeFilter(v || '')} />
        <Select placeholder="状态筛选" allowClear style={{ width: 140 }}
          options={statusOptions}
          onChange={(v) => setStatusFilter(v || '')} />
        <DatePicker.RangePicker
          placeholder={['开始日期', '结束日期']}
          onChange={(v) => { setDateRange(v as any); }}
          style={{ width: 240 }}
        />
      </div>
      <Table
        rowKey={(r) => `${r.targetType}-${r.targetId}`}
        loading={loading}
        columns={columns}
        dataSource={data}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        size="middle"
      />
    </>
  );
}

/** 待审批 Tab */
function PendingApprovalTab() {
  const [data, setData] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRows, setSelectedRows] = useState<React.Key[]>([]);
  const [comment, setComment] = useState('');
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await approvalApi.getPending({ pageSize: 100 });
      if (res.data) setData(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '待审批列表加载失败'));
      setData([]);
    }
    setLoading(false);
  };

  const handleApprove = async (action: 'approve' | 'reject') => {
    if (selectedRows.length === 0) return message.warning('请选择审批项');
    try {
      const items = selectedRows.map(key => {
        const item = data.find(d => (d.taskId ?? d.targetId) === key);
        return { targetType: item!.targetType, targetId: item!.targetId, action, comment };
      });
      await approvalApi.approve(items);
      message.success(action === 'approve' ? '审批通过' : '已驳回');
      setSelectedRows([]);
      setComment('');
      loadData();
    } catch (error) {
      message.error(getErrorMessage(error, action === 'approve' ? '批量通过失败' : '批量驳回失败'));
    }
  };

  const columns = [
    {
      title: '类型', dataIndex: 'targetType', key: 'type', width: 80,
      render: (t: string) => <Tag color="blue">{typeLabels[t] || t}</Tag>,
    },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    { title: '申请人', dataIndex: 'applicant', key: 'applicant', width: 100 },
    { title: '部门', dataIndex: 'department', key: 'department', width: 120 },
    {
      title: '工时(天)', dataIndex: 'hours', key: 'hours', width: 80,
      render: (h: number | undefined) => h ? `${h}天` : '-',
    },
    {
      title: '审批进度', key: 'progress', width: 200,
      render: (_: any, r: any) => (
        <span>
          <Text type="secondary">步骤 {r.currentStep}/{r.totalSteps}</Text>
          {r.currentStepLabel && <Tag color="purple" style={{ marginLeft: 8 }}>{r.currentStepLabel}</Tag>}
          {r.currentStepApprover && <Text type="secondary" style={{ marginLeft: 4 }}>({r.currentStepApprover})</Text>}
        </span>
      ),
    },
    {
      title: '提交时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
      render: (t: string) => t ? new Date(t).toLocaleString() : '-',
    },
    {
      title: '操作', key: 'action', width: 100, fixed: 'right' as const,
      render: (_: any, r: any) => (
        <Button type="link" size="small" onClick={() => navigate(`/approval/detail/${r.targetType}/${r.targetId}`)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <>
      <Table
        rowKey={(record) => record.taskId ?? record.targetId}
        loading={loading}
        columns={columns}
        dataSource={data}
        rowSelection={{
          type: 'checkbox',
          selectedRowKeys: selectedRows,
          onChange: (keys) => setSelectedRows(keys),
        }}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        size="middle"
        scroll={{ x: 1000 }}
      />
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <TextArea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="审批意见（可选）"
          style={{ width: 300 }}
          rows={1}
        />
        <Button type="primary" icon={<CheckOutlined />} onClick={() => handleApprove('approve')}
          disabled={selectedRows.length === 0}>
          批量通过 ({selectedRows.length})
        </Button>
        <Button danger icon={<CloseOutlined />} onClick={() => handleApprove('reject')}
          disabled={selectedRows.length === 0}>
          批量驳回
        </Button>
      </div>
    </>
  );
}

/** 已审批 Tab */
function ApprovedByMeTab() {
  const [data, setData] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, [typeFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await approvalApi.getHistory({
        pageSize: 100,
        mine: true,
        targetType: typeFilter || undefined,
      });
      if (res.data) setData(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '已审批列表加载失败'));
      setData([]);
    }
    setLoading(false);
  };

  const columns = [
    {
      title: '类型', dataIndex: 'targetType', key: 'type', width: 80,
      render: (t: string) => <Tag color="blue">{typeLabels[t] || t}</Tag>,
    },
    {
      title: '审批结果', dataIndex: 'action', key: 'action', width: 100,
      render: (action: string) => (
        <Tag color={action === 'approve' ? 'green' : 'red'}>{action === 'approve' ? '已通过' : '已驳回'}</Tag>
      ),
    },
    { title: '步骤', dataIndex: 'stepLabel', key: 'stepLabel', width: 140, render: (v: string) => v || '-' },
    { title: '审批意见', dataIndex: 'comment', key: 'comment', ellipsis: true, render: (v: string) => v || '-' },
    {
      title: '审批时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
      render: (t: string) => t ? new Date(t).toLocaleString() : '-',
    },
    {
      title: '操作', key: 'actionCol', width: 100, fixed: 'right' as const,
      render: (_: any, r: ApprovalRecord) => (
        <Button type="link" size="small" onClick={() => navigate(`/approval/detail/${r.targetType}/${r.targetId}`)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
        <Select placeholder="类型筛选" allowClear style={{ width: 140 }}
          options={[{ label: '工时', value: 'timesheet' }, { label: '加班', value: 'overtime' }, { label: '周报', value: 'weekly_report' }]}
          onChange={(v) => setTypeFilter(v || '')} />
      </div>
      <Table
        rowKey={(r) => r.id}
        loading={loading}
        columns={columns}
        dataSource={data}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        size="middle"
        scroll={{ x: 800 }}
      />
    </>
  );
}

/** 抄送给我的 Tab */
function MyCcTab() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await approvalApi.getMyCc({ pageSize: 100 });
      if (res.data) setData(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '抄送列表加载失败'));
      setData([]);
    }
    setLoading(false);
  };

  const columns = [
    {
      title: '类型', dataIndex: 'targetType', key: 'type', width: 80,
      render: (t: string) => <Tag color="blue">{typeLabels[t] || t}</Tag>,
    },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    { title: '抄送人', dataIndex: 'ccFrom', key: 'ccFrom', width: 100 },
    { title: '申请人', dataIndex: 'applicant', key: 'applicant', width: 100 },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label}</Tag>,
    },
    {
      title: '抄送时间', dataIndex: 'ccAt', key: 'ccAt', width: 170,
      render: (t: string) => t ? new Date(t).toLocaleString() : '-',
    },
    {
      title: '操作', key: 'action', width: 100,
      render: (_: any, r: any) => (
        <Button type="link" size="small" onClick={() => navigate(`/approval/detail/${r.targetType}/${r.targetId}`)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <Table
      rowKey={(r) => `${r.targetType}-${r.targetId}`}
      loading={loading}
      columns={columns}
      dataSource={data}
      pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      size="middle"
    />
  );
}

export default function Approval() {
  const [tabKey, setTabKey] = useState('my');

  const tabItems = [
    { key: 'my', label: '我的申请' },
    { key: 'pending', label: '待审批' },
    { key: 'approved', label: '已审批' },
    { key: 'cc', label: '抄送给我的' },
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>审批中心</Title>

      <Card style={{ borderRadius: 12 }}>
        <Tabs activeKey={tabKey} onChange={setTabKey} items={tabItems} />
        {tabKey === 'my' && <MySubmissionsTab />}
        {tabKey === 'pending' && <PendingApprovalTab />}
        {tabKey === 'approved' && <ApprovedByMeTab />}
        {tabKey === 'cc' && <MyCcTab />}
      </Card>
    </div>
  );
}

