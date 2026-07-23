import { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Table, Button, Space, Select, InputNumber, Tag, message, Typography, Row, Col,
  DatePicker, Popconfirm, Input, Tooltip, Modal,
} from 'antd';
import { PlusOutlined, SendOutlined, DeleteOutlined, SaveOutlined, LeftOutlined, RightOutlined, CopyOutlined, EditOutlined, FileSearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { timesheetApi } from '../../api/timesheet';
import { approvalApi } from '../../api/approval';
import { systemApi } from '../../api/system';
import { statusMap } from '../../types';
import type { Timesheet as TimesheetData, Project } from '../../types';
import { usePermission } from '../../hooks/usePermission';

dayjs.extend(isoWeek);

const { Title, Text } = Typography;

/** 周表格中的一行数据 */
interface WeekRow {
  key: string;
  projectId: number | undefined;
  description: string;
  days: Record<string, number>; // { 'YYYY-MM-DD': number }
  status?: string; // draft | submitted | approved | rejected
  originalStatus?: string; // 加载时的原始状态，用于区分保存草稿还是修改
  targetId?: number; // 该组第一条 timesheet 记录的 id（用于撤回审批）
}

const dayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function getErrorMessage(error: unknown, fallback: string) {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
}

/** 获取某周周一到周日的日期数组 */
function getWeekDates(weekStart: dayjs.Dayjs): string[] {
  return Array.from({ length: 7 }, (_, i) => weekStart.add(i, 'day').format('YYYY-MM-DD'));
}

let rowKeyCounter = 0;
function newRow(): WeekRow {
  return { key: `row_${++rowKeyCounter}_${Date.now()}`, projectId: undefined, description: '', days: {} };
}

/** 工时填报单位（天步长）可选值与默认值 */
const UNIT_OPTIONS = [0.1, 0.2, 0.25, 0.5];
const DEFAULT_UNIT = 0.5;
/** 把后端原始值（字符串）解析为合法步长 number，非法/老值归一为默认 */
function parseUnit(raw: unknown): number {
  const n = Number(raw);
  return UNIT_OPTIONS.includes(n) ? n : DEFAULT_UNIT;
}
/** 按步长对齐：四舍五入到最近的步长倍数，并修掉浮点误差，clamp [0,1] */
function snapToStep(value: number, step: number): number {
  if (value <= 0) return 0;
  const snapped = Math.round(value / step) * step;
  return Math.min(1, Number(snapped.toFixed(4)));
}

/**
 * 求和并修掉浮点累加误差。
 * JS 浮点 0.1+0.2=0.30000000000000004，直接 reduce 多个 0.1 步长会得到
 * 1.0999999999999999 这种值。这里累加后四舍五入到 2 位小数
 * （最小步长 0.1，合计最多 1 位小数，2 位容差足够消除误差）。
 * 注意：Postgres numeric 经 JSON 常为字符串，必须 Number()，否则 "0.5"+0.5 会变成字符串拼接。
 */
function sumRound(values: Array<number | string | null | undefined>): number {
  const total = values.reduce<number>((s, v) => s + (Number(v) || 0), 0);
  return Number(total.toFixed(2));
}

/** API 工时天数 → number（兼容 PG numeric 字符串） */
function toDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export default function TimesheetPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [historyData, setHistoryData] = useState<TimesheetData[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().startOf('month'), dayjs().endOf('month'),
  ]);

  // 周表格相关状态
  const [currentWeekStart, setCurrentWeekStart] = useState<dayjs.Dayjs>(dayjs().isoWeekday(1));
  const [rows, setRows] = useState<WeekRow[]>([newRow()]);
  // 脏标志：自上次加载/保存以来是否有未保存的改动。切周前据此判断是否提示。
  // 之前用 originalStatus==='draft' 派生判断会误报（已保存草稿也恒为 draft）且漏报（新行 undefined）。
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [weekLoading, setWeekLoading] = useState(false);
  const [editing, setEditing] = useState(false); // 编辑模式：控制已提交/已审批行是否可编辑
  const rowSnapshotRef = useRef<Map<string, WeekRow>>(new Map()); // 编辑模式开始时的行快照
  const weekLoadReqId = useRef(0); // 切周请求竞态守卫：只接受最新一次的响应

  // 系统设置：工时填报单位（天步长），默认 0.5 天
  const [unitStep, setUnitStep] = useState<number>(DEFAULT_UNIT);
  const [settingsLoaded, setSettingsLoaded] = useState(false); // 设置加载完成前禁用工时输入，防竞态

  const { hasPermission } = usePermission();
  const canCreate = hasPermission('timesheet:create');
  const canViewSelf = hasPermission('timesheet:view:self');
  const canUpdate = hasPermission('timesheet:update:self');
  const canDelete = hasPermission('timesheet:delete:self');
  const canSubmit = hasPermission('timesheet:submit:self');
  const canWithdraw = hasPermission('approval:withdraw:self');
  const canFill = canCreate && canViewSelf;

  // 判断当前周是否有已提交/已审批的行
  const hasSubmittedRows = rows.some(r => r.originalStatus && r.originalStatus !== 'draft');
  // 判断当前周是否有审批中的行（用于区分"撤回修改"和"修改工时"按钮）
  const hasPendingRows = rows.some(r => r.originalStatus === 'submitted');

  const unitLabel = '天';
  const minWeekTotal = 5; // 周合计不少于5天

  const weekDates = useMemo(() => getWeekDates(currentWeekStart), [currentWeekStart]);

  useEffect(() => {
    loadProjects();
    loadSettings();
  }, []);

  useEffect(() => {
    loadHistory();
  }, [dateRange]);

  useEffect(() => {
    loadWeekDrafts();
  }, [currentWeekStart, projects]);

  const loadSettings = async () => {
    try {
      const res = await systemApi.getSettings();
      if (res.data?.settings?.timesheet_unit) {
        setUnitStep(parseUnit(res.data.settings.timesheet_unit));
      }
    } catch (error) {
      message.warning(getErrorMessage(error, '系统设置加载失败，已使用默认工时单位'));
    } finally {
      setSettingsLoaded(true);
    }
  };

  const loadProjects = async () => {
    try {
      const res = await systemApi.getActiveProjects();
      if (res.data) setProjects(res.data as any);
    } catch (error) {
      message.error(getErrorMessage(error, '项目列表加载失败'));
    }
  };

  const loadHistory = async () => {
    if (!canViewSelf) {
      setHistoryData([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await timesheetApi.getMy({
        startDate: dateRange[0].format('YYYY-MM-DD'),
        endDate: dateRange[1].format('YYYY-MM-DD'),
        pageSize: 100,
        includeAll: 'true',
      });
      if (res.data) setHistoryData(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '工时历史加载失败'));
      setHistoryData([]);
    }
    setHistoryLoading(false);
  };

  /** 加载当前周已有的工时数据（含已提交/已通过），填充到周表格 */
  const loadWeekDrafts = async () => {
    if (!canViewSelf) {
      setRows([newRow()]);
      setDirty(false);
      return;
    }
    // 竞态守卫：快速切周时只接受最后一次请求的响应，避免旧响应覆盖新数据
    const reqId = ++weekLoadReqId.current;
    setWeekLoading(true);
    try {
      // 加载该周所有状态的工时记录
      const res = await timesheetApi.getMy({
        startDate: weekDates[0],
        endDate: weekDates[6],
        pageSize: 200,
      });
      if (reqId !== weekLoadReqId.current) return; // 已有更新的请求，丢弃本次响应
      if (res.data && res.data.list.length > 0) {
        // 过滤掉已驳回/已撤回的记录——这些工时不在周表格中展示/编辑，仅保留在历史记录中查看详情
        const allItems = res.data.list.filter(item => item.status !== 'rejected' && item.status !== 'withdrawn');
        // 按 projectId 分组（合并所有状态）
        const byProject: Record<number, { items: TimesheetData[]; status: string; originalStatus: string }> = {};
        for (const item of allItems) {
          if (!byProject[item.projectId]) {
            byProject[item.projectId] = { items: [], status: item.status, originalStatus: item.status };
          }
          byProject[item.projectId].items.push(item);
          // 优先展示非草稿状态
          if (item.status !== 'draft') {
            byProject[item.projectId].status = item.status;
            byProject[item.projectId].originalStatus = item.status;
          }
        }
        const loadedRows: WeekRow[] = Object.entries(byProject).map(([pid, group]) => {
          const days: Record<string, number> = {};
          let desc = '';
          group.items.forEach(item => {
            days[item.date] = toDays(item.days);
            if (item.description) desc = item.description;
          });
          return {
            key: `row_${++rowKeyCounter}_${Date.now()}`,
            projectId: Number(pid),
            description: desc,
            days,
            status: group.status,
            originalStatus: group.originalStatus,
            targetId: group.items[0]?.id,
          };
        });
        setRows(loadedRows.length > 0 ? loadedRows : [newRow()]);
        setEditing(false);
        setDirty(false);
      } else {
        setRows([newRow()]);
        setDirty(false);
      }
    } catch (error) {
      if (reqId !== weekLoadReqId.current) return;
      message.error(getErrorMessage(error, '本周工时加载失败'));
      setRows([newRow()]);
      setDirty(false);
    } finally {
      if (reqId === weekLoadReqId.current) setWeekLoading(false);
    }
  };

  // ===== 周表格操作 =====

  const addRow = () => { setRows(prev => [...prev, newRow()]); setDirty(true); };

  const removeRow = async (key: string) => {
    const row = rows.find(r => r.key === key);
    if (!row) return;
    // 草稿行：从数据库中删除该项目的草稿记录
    if (row.originalStatus === 'draft' && row.projectId) {
      try {
        const res = await timesheetApi.getMy({
          startDate: weekDates[0],
          endDate: weekDates[6],
          status: 'draft',
          pageSize: 200,
        });
        if (res.data?.list) {
          for (const item of res.data.list) {
            if (item.projectId === row.projectId) {
              await timesheetApi.delete(item.id);
            }
          }
        }
        message.success('草稿已删除');
        loadHistory();
        await loadWeekDrafts(); // 同步刷新周表，UI 与 DB 一致（loadWeekDrafts 已重置 dirty）
        return; // draft 删除已通过 loadWeekDrafts 刷新 UI，无需再手动 setRows
      } catch (error) {
        message.error(getErrorMessage(error, '删除失败'));
        return;
      }
    }
    // 非 draft 行（如已提交行）从 UI 移除：标记 dirty，待用户保存
    setRows(prev => prev.length <= 1 ? [newRow()] : prev.filter(r => r.key !== key));
    setDirty(true);
  };

  const updateRow = (key: string, field: Partial<WeekRow>) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, ...field } : r));
    setDirty(true);
  };

  /** 获取某行可选的项目列表（排除其他行已选的） */
  const getAvailableProjects = (currentRowKey: string) => {
    const usedIds = rows.filter(r => r.key !== currentRowKey && r.projectId).map(r => r.projectId!);
    return projects.filter(p => !usedIds.includes(p.id));
  };

  const updateDays = (key: string, date: string, value: number | null) => {
    let corrected = value || 0;
    // 按填报单位步长校正（自动修正为最近的步长倍数）
    if (corrected > 0) {
      corrected = snapToStep(corrected, unitStep);
    }
    // 单日工时校验：计算当前日期其他行的工时之和（sumRound 避免浮点累加误差）
    const otherRowsTotal = sumRound(rows.filter(r => r.key !== key).map(r => r.days[date] || 0));
    const dayLimit = 1; // 每天最多1天
    if (sumRound([otherRowsTotal, corrected]) > dayLimit) {
      message.warning(`${dayjs(date).format('M月D日')}工时合计不能超过1天，当前已有 ${otherRowsTotal}${unitLabel}`);
      return;
    }
    setRows(prev => prev.map(r =>
      r.key === key ? { ...r, days: { ...r.days, [date]: corrected } } : r
    ));
    setDirty(true);
  };

  // 切周前检查是否有未保存的改动（基于 dirty 标志，而非 originalStatus——已保存草稿 originalStatus 也是 draft 会误报）
  const hasUnsavedDraft = () => dirty;
  const switchWeek = (newWeek: dayjs.Dayjs) => {
    if (hasUnsavedDraft()) {
      Modal.confirm({
        title: '确认切换周次',
        content: '当前周有未保存的草稿工时，切换后将丢失，是否继续？',
        okText: '切换',
        okType: 'danger',
        cancelText: '取消',
        onOk: () => setCurrentWeekStart(newWeek),
      });
    } else {
      setCurrentWeekStart(newWeek);
    }
  };
  const prevWeek = () => switchWeek(currentWeekStart.subtract(7, 'day'));
  const nextWeek = () => switchWeek(currentWeekStart.add(7, 'day'));
  const goThisWeek = () => switchWeek(dayjs().isoWeekday(1));

  /** 复制上周工时 */
  const handleCopyLastWeek = async () => {
    const lastWeekStart = currentWeekStart.subtract(7, 'day');
    const lastWeekEnd = lastWeekStart.add(6, 'day');
    try {
      const res = await timesheetApi.getMy({
        startDate: lastWeekStart.format('YYYY-MM-DD'),
        endDate: lastWeekEnd.format('YYYY-MM-DD'),
        pageSize: 200,
      });
      if (!res.data?.list?.length) {
        message.info('上周没有工时记录');
        return;
      }
      // 按项目分组
      const grouped: Record<number, typeof res.data.list> = {};
      for (const item of res.data.list) {
        if (!grouped[item.projectId]) grouped[item.projectId] = [];
        grouped[item.projectId].push(item);
      }
      const newRows: WeekRow[] = Object.entries(grouped).map(([pid, items]) => {
        const days: Record<string, number> = {};
        let desc = '';
        items.forEach(item => {
          // 将上周的周几映射到本周的周几
          const dow = dayjs(item.date).isoWeekday();
          const targetDate = currentWeekStart.add(dow - 1, 'day').format('YYYY-MM-DD');
          days[targetDate] = toDays(item.days);
          if (item.description) desc = item.description;
        });
        return { key: `row_${++rowKeyCounter}_${Date.now()}`, projectId: Number(pid), description: desc, days };
      });
      if (newRows.length === 0) return;

      // 本周已有非空数据时，覆盖前需二次确认，避免误丢已填内容
      const hasCurrentData = rows.some(r => weekDates.some(d => (r.days[d] || 0) > 0));
      const doCopy = () => {
        setRows(newRows);
        setDirty(true);
        message.success(`已复制上周 ${newRows.length} 个项目行`);
      };
      if (hasCurrentData) {
        Modal.confirm({
          title: '确认覆盖本周工时',
          content: '本周已填写工时，复制上周将覆盖当前内容，是否继续？',
          okText: '覆盖',
          okType: 'danger',
          cancelText: '取消',
          onOk: doCopy,
        });
      } else {
        doCopy();
      }
    } catch (error) {
      message.error(getErrorMessage(error, '复制上周工时失败'));
    }
  };

  /** 计算一行总计 */
  const rowTotal = (row: WeekRow) => sumRound(weekDates.map(d => row.days[d] || 0));

  /** 计算每天列总计 */
  const dayTotals = useMemo(() => {
    return weekDates.map(d => sumRound(rows.map(r => r.days[d] || 0)));
  }, [rows, weekDates]);

  /** 周总工时 */
  const weekTotal = useMemo(() => sumRound(dayTotals), [dayTotals]);

  /** 收集有效数据（所有行） */
  const collectItems = () => {
    const items: { projectId: number; date: string; days: number; description?: string }[] = [];
    for (const row of rows) {
      if (!row.projectId) continue;
      for (const date of weekDates) {
        const h = row.days[date];
        if (h && h > 0) {
          items.push({ projectId: row.projectId, date, days: h, description: row.description || undefined });
        }
      }
    }
    return items;
  };

  /** 校验周工时 */
  const validateWeekTotal = (items: { days: number }[]) => {
    const total = sumRound(items.map(i => i.days));
    if (total < 5) {
      message.warning(`每周工时合计不得少于5天，当前仅 ${total} 天`);
      return false;
    }
    return true;
  };

  /** 检测行是否有变更（对比编辑模式开始时的快照） */
  const isRowChanged = (row: WeekRow): boolean => {
    const snap = rowSnapshotRef.current.get(row.key);
    if (!snap) return true; // 新增的行，视为变更
    if (snap.projectId !== row.projectId) return true;
    if (snap.description !== row.description) return true;
    for (const date of weekDates) {
      if ((snap.days[date] || 0) !== (row.days[date] || 0)) return true;
    }
    return false;
  };

  /** 保存草稿 / 修改工时 */
  const handleSaveDraft = async () => {
    if (editing) {
      if (!validateWeekTotal(collectItems())) return;
      // 编辑模式下：只保存有变更的行（对比快照）
      const submittedRows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[] = [];
      for (const row of rows) {
        if (!row.projectId || !row.originalStatus || row.originalStatus === 'draft') continue;
        // ★ 跳过未修改的行
        if (!isRowChanged(row)) continue;
        const entries = weekDates
          .filter(d => row.days[d] && row.days[d] > 0)
          .map(d => ({ date: d, days: row.days[d] }));
        if (entries.length === 0) {
          message.warning('修改后的项目至少需要保留一天有效工时，不能直接清空整行');
          return;
        }
        submittedRows.push({
          projectId: row.projectId,
          description: row.description || '',
          weekStart: weekDates[0],
          entries,
        });
      }
      if (submittedRows.length === 0) {
        message.info('没有检测到修改，无需保存');
        return;
      }
      // 工作内容必填校验（提交审批/修改场景；草稿不校验）
      const missingDescProj = submittedRows.find(r => !r.description.trim());
      if (missingDescProj) {
        message.warning('请填写每条工时的工作内容后再提交');
        return;
      }
      setSaving(true);
      try {
        await timesheetApi.modifySubmitted(submittedRows);
        message.success('工时已修改，新审批已自动发起');
        setEditing(false);
        setDirty(false);
        loadWeekDrafts();
        loadHistory();
      } catch (error) {
        message.error(getErrorMessage(error, '修改工时保存失败'));
      }
      setSaving(false);
      return;
    }

    // 普通模式：保存草稿行
    const draftRows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[] = [];
    for (const row of rows) {
      if (!row.projectId) continue;
      if (row.originalStatus && row.originalStatus !== 'draft') continue;
      const entries = weekDates
        .filter(d => row.days[d] && row.days[d] > 0)
        .map(d => ({ date: d, days: row.days[d] }));
      if (entries.length === 0) continue;
      draftRows.push({
        projectId: row.projectId,
        description: row.description || '',
        weekStart: weekDates[0],
        entries,
      });
    }

    if (draftRows.length === 0) {
      message.warning('请至少填写一条有效工时');
      return;
    }

    setSaving(true);
    try {
      const draftItems = draftRows.flatMap(r => r.entries.map(e => ({
        projectId: r.projectId, date: e.date, days: e.days, description: r.description || undefined,
      })));
      await timesheetApi.replaceWeekDrafts(weekDates[0], draftItems);
      message.success('草稿已保存');
      setDirty(false);
      loadWeekDrafts();
      loadHistory();
    } catch (error) {
      message.error(getErrorMessage(error, '草稿保存失败'));
    }
    setSaving(false);
  };

  /** 提交审批（按行提交，每行一个审批单，带确认弹窗） */
  const handleSubmitApproval = async () => {
    // 收集有效行（有项目且有工时的；非编辑模式下排除已提交/已审批行）
    const validRows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[] = [];
    for (const row of rows) {
      if (!row.projectId) continue;
      // 非编辑模式下，已通过/审批中的行不参与提交（驳回行和草稿行参与）
      if (!editing && row.originalStatus && row.originalStatus !== 'draft' && row.originalStatus !== 'rejected') continue;
      // 编辑模式下，已通过/审批中且未修改的行不参与提交
      if (editing && row.originalStatus && row.originalStatus !== 'draft' && !isRowChanged(row)) continue;
      const entries = weekDates
        .filter(d => row.days[d] && row.days[d] > 0)
        .map(d => ({ date: d, days: row.days[d] }));
      if (entries.length === 0) continue;
      validRows.push({
        projectId: row.projectId,
        description: row.description || '',
        weekStart: weekDates[0],
        entries,
      });
    }
    if (validRows.length === 0) {
      message.warning('请至少填写一条有效工时');
      return;
    }
    // 工作内容必填校验（提交审批场景）
    const missingDesc = validRows.find(r => !r.description.trim());
    if (missingDesc) {
      message.warning('请填写每条工时的工作内容后再提交');
      return;
    }
    // 校验周工时：计算整周总工时（包括已通过/审批中未修改的行）
    const allWeekItems = validRows.flatMap(r => r.entries);
    const submittedDays = sumRound(allWeekItems.map(e => e.days));
    const approvedDays = sumRound(
      rows
        .filter(r => (r.originalStatus === 'approved' || r.originalStatus === 'submitted')
          && (!editing || !isRowChanged(r)))
        .flatMap(r => weekDates.map(d => r.days[d] || 0))
    );
    const totalWeekDays = sumRound([submittedDays, approvedDays]);
    if (totalWeekDays < 5) {
      message.warning(`每周工时合计不得少于5天，当前仅 ${totalWeekDays} 天`);
      return;
    }

    // 构建预览信息
    const projectNames = validRows.map(r => {
      const p = projects.find(pp => pp.id === r.projectId);
      return p?.name || `项目#${r.projectId}`;
    });
    const totalH = sumRound(allWeekItems.map(e => e.days));

    Modal.confirm({
      title: '确认提交审批',
      content: (
        <div>
          <p>即将提交 <b>{validRows.length}</b> 个项目行的审批申请：</p>
          <ul style={{ paddingLeft: 20, margin: '8px 0' }}>
            {projectNames.map((name, i) => (
              <li key={i}>{name}：{sumRound(validRows[i].entries.map(e => e.days))}{unitLabel}</li>
            ))}
          </ul>
          <p>周合计：<b>{totalH}</b>{unitLabel}</p>
        </div>
      ),
      okText: '确认提交',
      cancelText: '取消',
      onOk: async () => {
        setSaving(true);
        try {
          await timesheetApi.submitByRows(validRows);
          message.success('已提交审批');
          setDirty(false);
          loadWeekDrafts();
          loadHistory();
        } catch (error) {
          message.error(getErrorMessage(error, '提交审批失败'));
        }
        setSaving(false);
      },
    });
  };

  // ===== 历史记录：按项目+周分组 =====
  interface HistoryGroup {
    key: string;
    projectId: number;
    projectName: string;
    weekStart: string;
    weekEnd: string;
    totalDays: number;
    status: string;
    description: string;
    targetId: number; // 用于跳转审批详情
    submissionGroupId: number | null;
    submittedAt: string;
    operationType: '提交' | '修改';
  }

  const historyGroups = useMemo<HistoryGroup[]>(() => {
    // 按 submissionGroupId 分组（有 groupId 的），无 groupId 的按 (projectId, week) 分组
    const groupMap = new Map<string, TimesheetData[]>();

    for (const item of historyData) {
      let groupKey: string;
      if (item.submissionGroupId) {
        groupKey = `g_${item.submissionGroupId}`;
      } else {
        // 草稿没有 submissionGroupId，按 (projectId, isoWeek) 分组
        const d = dayjs(item.date);
        const ws = d.isoWeekday(1).format('YYYY-MM-DD');
        groupKey = `p_${item.projectId}_${ws}`;
      }
      if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
      groupMap.get(groupKey)!.push(item);
    }

    const result: HistoryGroup[] = [];
    for (const [groupKey, items] of groupMap) {
      if (items.length === 0) continue;
      const first = items[0];
      const dates = items.map(i => i.date).sort();
      const ws = dayjs(dates[0]).isoWeekday(1).format('YYYY-MM-DD');
      const we = dayjs(ws).add(6, 'day').format('YYYY-MM-DD');
      const totalDays = sumRound(items.map(i => i.days));
      // 状态：如果全组都是 deprecated，则显示 deprecated；否则取最高优先级的非 draft 非 deprecated 状态
      const allDeprecated = items.every(i => i.status === 'deprecated');
      const status = allDeprecated
        ? 'deprecated'
        : items.find(i => i.status !== 'draft' && i.status !== 'deprecated')?.status
          || items.find(i => i.status !== 'draft')?.status
          || 'draft';
      const submittedAt = items
        .map(i => i.updatedAt || i.createdAt)
        .filter(Boolean)
        .sort()
        .pop() || '';

      // 判断操作类型：有 previousGroupId 说明是修改后重新提交
      const hasPreviousGroup = items.some(i => i.previousGroupId);
      const operationType: '提交' | '修改' = hasPreviousGroup ? '修改' : '提交';

      result.push({
        key: groupKey,
        projectId: first.projectId,
        projectName: first.project?.name || `项目#${first.projectId}`,
        weekStart: ws,
        weekEnd: we,
        totalDays,
        status,
        description: items.find(i => i.description)?.description || '',
        targetId: first.id,
        submissionGroupId: first.submissionGroupId || null,
        submittedAt,
        operationType,
      });
    }

    // 按提交时间倒序
    result.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    return result;
  }, [historyData]);

  const historyColumns = [
    {
      title: '提交日期', dataIndex: 'submittedAt', key: 'submittedAt', width: 120,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
      sorter: (a: HistoryGroup, b: HistoryGroup) => a.submittedAt.localeCompare(b.submittedAt),
    },
    {
      title: '项目', dataIndex: 'projectName', key: 'project', width: 150,
    },
    {
      title: '周期', key: 'week', width: 180,
      render: (_: any, r: HistoryGroup) => `${dayjs(r.weekStart).format('M/D')} ~ ${dayjs(r.weekEnd).format('M/D')}`,
    },
    {
      title: `工时(${unitLabel})`, dataIndex: 'totalDays', key: 'days', width: 80,
      sorter: (a: HistoryGroup, b: HistoryGroup) => a.totalDays - b.totalDays,
    },
    {
      title: '工作内容', dataIndex: 'description', key: 'description', ellipsis: true,
      render: (text: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{text || '-'}</span>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (status: string) => <Tag color={statusMap[status]?.color}>{statusMap[status]?.label}</Tag>,
    },
    {
      title: '操作类型', dataIndex: 'operationType', key: 'operationType', width: 90,
      render: (v: '提交' | '修改') => (
        <Tag color={v === '修改' ? 'orange' : 'blue'}>{v}</Tag>
      ),
    },
    {
      title: '操作', key: 'action', width: 100,
      render: (_: any, record: HistoryGroup) => {
        if (record.status === 'approved' || record.status === 'submitted') {
          return (
            <Button
              type="link" size="small"
              onClick={() => navigate(`/approval/detail/timesheet/${record.targetId}`)}
            >
              详情
            </Button>
          );
        }
        if (record.status === 'deprecated' || record.status === 'withdrawn') {
          return (
            <Button
              type="link" size="small"
              onClick={() => navigate(`/approval/detail/timesheet/${record.targetId}`)}
            >
              详情
            </Button>
          );
        }
        if (record.status === 'rejected') {
          return (
            <Button
              type="link" size="small"
              onClick={() => navigate(`/approval/detail/timesheet/${record.targetId}`)}
            >
              详情
            </Button>
          );
        }
        // 草稿
        if (!canFill && !canDelete) return '-';
        return (
          <Space>
            {canFill && (
              <Button
                type="link" size="small"
                onClick={() => setCurrentWeekStart(dayjs(record.weekStart))}
              >
                编辑
              </Button>
            )}
            {canDelete && (
              <Popconfirm
                title="确定删除该草稿？"
                onConfirm={async () => {
                  try {
                    const res = await timesheetApi.getMy({
                      startDate: record.weekStart,
                      endDate: record.weekEnd,
                      status: 'draft',
                      pageSize: 200,
                    });
                    if (res.data?.list) {
                      for (const item of res.data.list) {
                        if (item.projectId === record.projectId) {
                          await timesheetApi.delete(item.id);
                        }
                      }
                    }
                    message.success('草稿已删除');
                    loadHistory();
                    loadWeekDrafts();
                  } catch (error) {
                    message.error(getErrorMessage(error, '删除失败'));
                  }
                }}
              >
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  // ===== 周表格列定义 =====
  const isRowReadonly = (row: WeekRow) => {
    // 编辑模式下所有行可编辑
    if (editing) return !canUpdate;
    // 草稿和新行：可编辑
    if (!row.originalStatus || row.originalStatus === 'draft') return !canFill;
    // 驳回行：默认可编辑（用户可直接修改后重新提交）
    if (row.originalStatus === 'rejected') return false;
    // 已通过/审批中：只读
    return true;
  };

  const weekColumns = [
    {
      title: '项目',
      dataIndex: 'projectId',
      key: 'project',
      width: 180,
      render: (_: any, row: WeekRow) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Select
            style={{ flex: 1 }}
            placeholder="选择项目"
            value={row.projectId}
            onChange={(v) => updateRow(row.key, { projectId: v })}
            options={getAvailableProjects(row.key).map(p => ({ label: p.name, value: p.id }))}
            showSearch
            optionFilterProp="label"
            disabled={isRowReadonly(row)}
          />
          {row.status && row.status !== 'draft' && (
            <Tooltip title={row.status === 'rejected' ? '已驳回，编辑后请重新提交审批' : undefined}>
              <Tag color={statusMap[row.status]?.color} style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>
                {statusMap[row.status]?.label}
              </Tag>
            </Tooltip>
          )}
        </div>
      ),
    },
    ...weekDates.map((date, i) => ({
      title: (
        <div style={{ textAlign: 'center' }}>
          <div>{dayLabels[i]}</div>
          <div style={{ fontSize: 11, color: '#999' }}>{dayjs(date).format('M/D')}</div>
        </div>
      ),
      dataIndex: date,
      key: date,
      width: 90,
      render: (_: any, row: WeekRow) =>
        isRowReadonly(row) ? (
          <Text style={{ color: row.days[date] ? '#333' : '#ccc' }}>
            {row.days[date] || ''}
          </Text>
        ) : (
          <InputNumber
            min={0}
            max={1}
            step={unitStep}
            size="small"
            value={row.days[date] || null}
            onChange={(v) => updateDays(row.key, date, v)}
            disabled={!settingsLoaded}
            style={{ width: '100%' }}
          />
        ),
    })),
    {
      title: '合计',
      key: 'total',
      width: 80,
      render: (_: any, row: WeekRow) => {
        const total = rowTotal(row);
        return <Text strong style={{ color: total > 0 ? '#6B8F71' : '#B0A898' }}>{total}</Text>;
      },
    },
    {
      title: '工作内容',
      dataIndex: 'description',
      key: 'description',
      width: 200,
      render: (_: any, row: WeekRow) =>
        isRowReadonly(row) ? (
          <Text style={{ whiteSpace: 'pre-wrap', color: '#666' }}>{row.description || '-'}</Text>
        ) : (
          <Input.TextArea
            placeholder="工作内容（支持换行）"
            value={row.description}
            onChange={(e) => updateRow(row.key, { description: e.target.value })}
            size="small"
            maxLength={1000}
            autoSize={{ minRows: 1, maxRows: 4 }}
          />
        ),
    },
    {
      title: '',
      key: 'action',
      width: 50,
      render: (_: any, row: WeekRow) => {
        const isPersistedSubmitted = !!row.originalStatus && row.originalStatus !== 'draft';
        const isPersistedDraft = row.originalStatus === 'draft';
        if (isPersistedDraft && canDelete) {
          return (
            <Popconfirm title="确定删除该草稿？" onConfirm={() => removeRow(row.key)}>
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          );
        }
        const disabled = rows.length <= 1 || isRowReadonly(row) || isPersistedSubmitted;
        return (
          <Tooltip title={isPersistedSubmitted ? '已提交工时不支持整行删除' : '删除行'}>
            <Button
              type="text" size="small" danger icon={<DeleteOutlined />}
              onClick={() => removeRow(row.key)}
              disabled={disabled}
            />
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>工时填报</Title>

      {/* ===== 周工时填报表 ===== */}
      <Card
        title={
          <Row justify="space-between" align="middle">
            <Col>
              <Space size="middle">
                <Button aria-label="上一周" icon={<LeftOutlined />} onClick={prevWeek} size="small" />
                <span style={{ fontWeight: 600, fontSize: 15 }}>
                  {currentWeekStart.format('YYYY年M月D日')} — {currentWeekStart.add(6, 'day').format('M月D日')}
                </span>
                <Button aria-label="下一周" icon={<RightOutlined />} onClick={nextWeek} size="small" />
                <Button size="small" onClick={goThisWeek}>本周</Button>
                {canFill && (
                  <Tooltip title="复制上周工时到当前周">
                    <Button size="small" icon={<CopyOutlined />} onClick={handleCopyLastWeek}>复制上周</Button>
                  </Tooltip>
                )}
              </Space>
            </Col>
            <Col>
              <Space>
                {(canCreate || canUpdate || canSubmit) && (
                  <>
                    {canUpdate && hasSubmittedRows && !editing && (!hasPendingRows || canWithdraw) ? (
                      <Button
                        icon={<EditOutlined />}
                        onClick={() => {
                          if (hasPendingRows) {
                            // 有审批中的提交：先撤回本周所有审批中的单子，再进入编辑
                            const pendingTargetIds = [...new Set(rows
                              .filter(r => r.originalStatus === 'submitted' && r.targetId)
                              .map(r => r.targetId!))];
                            const editableRows = rows.map(r => ({ ...r, days: { ...r.days } }));
                            Modal.confirm({
                              title: '撤回确认',
                              content: '此操作会撤回本周所有正在审批中的提交，已审批通过的不受影响，确认撤回吗？',
                              okText: '确认撤回',
                              cancelText: '取消',
                              onOk: async () => {
                                const results = await Promise.allSettled(
                                  pendingTargetIds.map(id => approvalApi.withdraw('timesheet', id))
                                );
                                const failed = results.filter(result => result.status === 'rejected');
                                if (failed.length) {
                                  message.error(failed.length === results.length
                                    ? '撤回失败，请刷新后重试'
                                    : '部分审批已撤回、部分失败，已刷新当前周，请确认后重试');
                                  await Promise.all([loadWeekDrafts(), loadHistory()]);
                                  return;
                                }
                                message.success('已撤回审批中的提交，可以继续修改');
                                rowSnapshotRef.current = new Map(editableRows.map(r => [r.key, r]));
                                setRows(editableRows.map(r => r.originalStatus === 'submitted'
                                  ? { ...r, status: 'withdrawn' }
                                  : r));
                                setDirty(false);
                                setEditing(true);
                                void loadHistory();
                              },
                            });
                          } else {
                            // 无审批中的提交（仅有已通过的）：直接进入编辑（走 modifySubmitted 逻辑）
                            const snap = new Map<string, WeekRow>();
                            rows.forEach(r => snap.set(r.key, { ...r, days: { ...r.days } }));
                            rowSnapshotRef.current = snap;
                            setEditing(true);
                          }
                        }}
                      >
                        {hasPendingRows ? '撤回修改' : '修改工时'}
                      </Button>
                    ) : null}
                    {canFill && !editing && !hasSubmittedRows && (
                      <Button
                        icon={<SaveOutlined />}
                        onClick={handleSaveDraft}
                        loading={saving}
                      >
                        保存草稿
                      </Button>
                    )}
                    {canFill && canSubmit && !editing && (
                      <Button type="primary" icon={<SendOutlined />} onClick={handleSubmitApproval} loading={saving}>
                        提交审批
                      </Button>
                    )}
                    {editing && canUpdate && (
                      <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveDraft} loading={saving}>
                        保存修改并重新提交
                      </Button>
                    )}
                    {editing && (
                      <Button onClick={() => { setEditing(false); loadWeekDrafts(); }}>
                        取消
                      </Button>
                    )}
                  </>
                )}
              </Space>
            </Col>
          </Row>
        }
        style={{ borderRadius: 12, marginBottom: 16 }}
      >
        <Table
          rowKey="key"
          loading={weekLoading}
          columns={weekColumns}
          dataSource={rows}
          pagination={false}
          size="small"
          bordered
          scroll={{ x: 'max-content' }}
          footer={() => (
            <Row justify="space-between" align="middle">
              <Col>
                {canFill && !editing && <Button type="dashed" icon={<PlusOutlined />} onClick={addRow}>添加项目行</Button>}
              </Col>
              <Col>
                <Space size="large">
                  {dayLabels.map((label, i) => (
                    <span key={label}>
                      {label}：<Text strong={dayTotals[i] > 0}>{dayTotals[i]}</Text>{unitLabel}
                    </span>
                  ))}
                  <span>
                    周合计：<Text strong style={{ color: weekTotal >= minWeekTotal ? '#6B8F71' : '#C0564B', fontSize: 15 }}>{weekTotal}</Text>{unitLabel}
                    {weekTotal < 5 && <Text type="warning" style={{ marginLeft: 8 }}>(不足5天)</Text>}
                  </span>
                </Space>
              </Col>
            </Row>
          )}
        />
      </Card>

      {/* ===== 历史记录 ===== */}
      <Card
        title="历史记录"
        style={{ borderRadius: 12 }}
        extra={
          <Space>
            <DatePicker.RangePicker
              value={dateRange}
              onChange={(v) => { if (v && v[0] && v[1]) { setDateRange([v[0], v[1]]); } }}
              allowClear={false}
            />
            <Button type="primary" onClick={loadHistory}>查询</Button>
          </Space>
        }
      >
        <Table
          rowKey="key"
          loading={historyLoading}
          columns={historyColumns}
          dataSource={historyGroups}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
          size="middle"
        />
      </Card>
    </div>
  );
}
