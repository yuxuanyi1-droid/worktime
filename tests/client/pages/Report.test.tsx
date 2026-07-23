import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportPage from '@client/pages/Report';
import { reportApi } from '@client/api/report';
import { useAuthStore } from '@client/stores/authStore';
import request from '@client/utils/request';

vi.mock('@client/api/report', () => ({
  reportApi: {
    getScope: vi.fn(),
    getPersonal: vi.fn(),
    getGroup: vi.fn(),
    getDepartment: vi.fn(),
    getProject: vi.fn(),
    getOvertime: vi.fn(),
  },
}));

vi.mock('@client/utils/request', () => ({
  default: { get: vi.fn() },
}));

vi.mock('@client/components/Charts/LazyEChart', () => ({
  default: ({ option }: { option: unknown }) => (
    <div data-testid="report-chart" data-option={JSON.stringify(option)} />
  ),
}));

const scope = {
  canViewPersonal: true,
  canViewGroup: true,
  canViewDepartment: false,
  canViewProject: false,
  canViewOvertime: true,
  departments: [{ id: 1, name: '研发部' }],
  groups: [
    { id: 10, name: '一组', departmentId: 1 },
    { id: 11, name: '二组', departmentId: 1 },
  ],
  projects: [],
  overtimeProjects: [{ id: 21, name: '工时平台', code: 'WORKTIME', status: 'active' }],
  exportScope: { unrestricted: true, departmentIds: [], groupIds: [], projectIds: [] },
};

function setUser(permissions: string[]) {
  useAuthStore.setState({
    token: 'report-token',
    user: {
      id: 1,
      username: 'report-user',
      realName: '报表用户',
      department: null,
      group: null,
      roles: [],
      permissions,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('报表页面', () => {
  beforeEach(() => {
    vi.mocked(reportApi.getScope).mockResolvedValue({ code: 0, data: scope } as any);
    vi.mocked(reportApi.getPersonal).mockResolvedValue({
      code: 0,
      data: { totalDays: 5, byDate: { '2026-07-01': 1 }, byProject: { '项目甲': { days: 5, count: 5 } }, records: [] },
    } as any);
    vi.mocked(reportApi.getGroup).mockImplementation(async (groupId) => ({
      code: 0,
      data: {
        groupId,
        totalDays: groupId === 10 ? 5 : 3,
        byDate: { '2026-07-01': 1 },
        byUser: { [groupId === 10 ? '成员甲' : '成员乙']: { days: groupId === 10 ? 5 : 3, count: 3 } },
        byProject: {},
        records: [],
      },
    } as any));
    vi.mocked(reportApi.getOvertime).mockResolvedValue({
      code: 0,
      data: { totalDays: 1.5, byType: { weekend: 1.5 }, byUser: { '成员甲': 1.5 }, records: [] },
    } as any);
    vi.mocked(reportApi.getDepartment).mockResolvedValue({
      code: 0,
      data: {
        departmentId: 1,
        totalDays: 4,
        byDate: {},
        byUser: { '部门成员': { days: 4, count: 2 } },
        byProject: {},
        records: [],
      },
    } as any);
    vi.mocked(reportApi.getProject).mockResolvedValue({
      code: 0,
      data: {
        projectId: 31,
        totalDays: 6,
        byDate: {},
        byUser: { '项目成员': { days: 6, count: 3 } },
        byGroup: {},
        records: [],
        filters: { departments: [], groups: [] },
      },
    } as any);
    vi.mocked(request.get).mockResolvedValue(new Blob(['excel-content']) as any);
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('只向具备导出权限的用户展示 Excel 导出入口', async () => {
    setUser(['report:access', 'report:view:self']);
    const { unmount } = render(<ReportPage />);
    expect(await screen.findByRole('tab', { name: '个人报表' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /导出Excel/ })).not.toBeInTheDocument();
    unmount();

    setUser(['report:access', 'report:view:self', 'report:export']);
    render(<ReportPage />);
    expect(await screen.findByRole('button', { name: /导出Excel/ })).toBeInTheDocument();
  });

  it('切换组别后立即清除旧结果，查询时使用新范围', async () => {
    setUser(['report:access', 'report:view:self', 'report:view:group']);
    const user = userEvent.setup();
    render(<ReportPage />);

    await user.click(await screen.findByRole('tab', { name: '组别报表' }));
    expect(await screen.findByText('成员甲')).toBeInTheDocument();

    const groupSelect = screen.getAllByRole('combobox').find((element) => element.getAttribute('role') === 'combobox')!;
    await user.click(groupSelect);
    await user.click(await screen.findByText('二组'));
    await waitFor(() => expect(screen.queryByText('成员甲')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '查 询' }));
    await waitFor(() => expect(reportApi.getGroup).toHaveBeenLastCalledWith(
      11, expect.any(String), expect.any(String),
    ));
    expect(await screen.findByText('成员乙')).toBeInTheDocument();
  });

  it('加班统计的图表单位与后端 days 字段一致为“天”', async () => {
    setUser(['report:access', 'report:view:overtime']);
    const user = userEvent.setup();
    render(<ReportPage />);

    await user.click(await screen.findByRole('tab', { name: '加班统计' }));
    await waitFor(() => expect(reportApi.getOvertime).toHaveBeenCalled());
    const options = (await screen.findAllByTestId('report-chart'))
      .map((element) => element.getAttribute('data-option') || '')
      .join('\n');
    expect(options).toContain('天');
    expect(options).not.toContain('小时');
  });

  it('范围加载完成后自动查询第一个可见报表', async () => {
    setUser(['report:access', 'report:view:self']);
    render(<ReportPage />);

    await waitFor(() => expect(reportApi.getPersonal).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('项目甲')).toBeInTheDocument();
  });

  it('范围加载失败不会伪装成无权限空态，并可原地重试', async () => {
    setUser(['report:access', 'report:view:self']);
    vi.mocked(reportApi.getScope)
      .mockRejectedValueOnce(new Error('范围服务不可用'))
      .mockResolvedValueOnce({ code: 0, data: scope } as any);
    const user = userEvent.setup();
    render(<ReportPage />);

    expect(await screen.findByText('范围服务不可用')).toBeInTheDocument();
    expect(screen.queryByText('暂无可查看的报表')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByRole('tab', { name: '个人报表' })).toBeInTheDocument();
    await waitFor(() => expect(reportApi.getPersonal).toHaveBeenCalledTimes(1));
  });

  it('查询失败清空旧结果并提供与当前筛选一致的重试入口', async () => {
    setUser(['report:access', 'report:view:self']);
    vi.mocked(reportApi.getPersonal)
      .mockRejectedValueOnce(new Error('个人报表暂不可用'))
      .mockResolvedValueOnce({
        code: 0,
        data: { totalDays: 2, byDate: {}, byProject: { '恢复项目': { days: 2, count: 1 } }, records: [] },
      } as any);
    const user = userEvent.setup();
    render(<ReportPage />);

    expect(await screen.findByText('个人报表暂不可用')).toBeInTheDocument();
    expect(screen.queryByText('项目甲')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByText('恢复项目')).toBeInTheDocument();
    expect(reportApi.getPersonal).toHaveBeenCalledTimes(2);
  });

  it('筛选变化会使在途查询失效，旧范围响应不能回填到新范围', async () => {
    setUser(['report:access', 'report:view:self', 'report:view:group']);
    const first = deferred<any>();
    vi.mocked(reportApi.getGroup)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => ({
        code: 0,
        data: { groupId: 11, totalDays: 3, byDate: {}, byUser: { '新范围成员': { days: 3, count: 1 } }, byProject: {}, records: [] },
      } as any));
    const user = userEvent.setup();
    render(<ReportPage />);

    await user.click(await screen.findByRole('tab', { name: '组别报表' }));
    await waitFor(() => expect(reportApi.getGroup).toHaveBeenCalledTimes(1));
    const select = screen.getAllByRole('combobox')[1] || screen.getAllByRole('combobox')[0];
    await user.click(select);
    await user.click(await screen.findByText('二组'));
    first.resolve({
      code: 0,
      data: { groupId: 10, totalDays: 5, byDate: {}, byUser: { '旧范围成员': { days: 5, count: 1 } }, byProject: {}, records: [] },
    });
    await Promise.resolve();
    expect(screen.queryByText('旧范围成员')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /查\s*询/ }));
    expect(await screen.findByText('新范围成员')).toBeInTheDocument();
    expect(reportApi.getGroup).toHaveBeenLastCalledWith(11, expect.any(String), expect.any(String));
  });

  it('范围化导出授权只在当前筛选落入授权范围时启用', async () => {
    setUser(['report:access', 'report:view:self', 'report:view:group', 'report:export']);
    vi.mocked(reportApi.getScope).mockResolvedValue({
      code: 0,
      data: {
        ...scope,
        exportScope: { unrestricted: false, departmentIds: [], groupIds: [11], projectIds: [] },
      },
    } as any);
    const user = userEvent.setup();
    render(<ReportPage />);

    const exportButton = await screen.findByRole('button', { name: /导出Excel/ });
    expect(exportButton).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: '组别报表' }));
    expect(exportButton).toBeDisabled();

    const groupSelect = screen.getAllByRole('combobox')[1] || screen.getAllByRole('combobox')[0];
    await user.click(groupSelect);
    await user.click(await screen.findByText('二组'));
    expect(exportButton).toBeEnabled();
  });

  it('项目范围的加班权限可通过项目筛选实际查询', async () => {
    setUser(['report:access', 'report:view:overtime']);
    vi.mocked(reportApi.getScope).mockResolvedValue({
      code: 0,
      data: {
        canViewPersonal: false,
        canViewGroup: false,
        canViewDepartment: false,
        canViewProject: false,
        canViewOvertime: true,
        departments: [],
        groups: [],
        projects: [],
        overtimeProjects: [{ id: 21, name: '工时平台', code: 'WORKTIME', status: 'active' }],
        exportScope: { unrestricted: false, departmentIds: [], groupIds: [], projectIds: [] },
      },
    } as any);
    const user = userEvent.setup();
    render(<ReportPage />);

    expect(await screen.findByRole('tab', { name: '加班统计' })).toBeInTheDocument();
    const projectSelect = (await screen.findAllByRole('combobox')).at(-1)!;
    await user.click(projectSelect);
    await user.click(await screen.findByText('工时平台（WORKTIME）'));
    await user.click(screen.getByRole('button', { name: /查\s*询/ }));

    await waitFor(() => expect(reportApi.getOvertime).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 21,
      departmentId: undefined,
      groupId: undefined,
    })));
  });

  it('部门报表切换部门时清空旧分组，并按新的部门和组别查询', async () => {
    setUser(['report:access', 'report:view:department']);
    vi.mocked(reportApi.getScope).mockResolvedValue({
      code: 0,
      data: {
        ...scope,
        canViewPersonal: false,
        canViewGroup: false,
        canViewDepartment: true,
        canViewOvertime: false,
        departments: [{ id: 1, name: '研发部' }, { id: 2, name: '质量部' }],
        groups: [
          { id: 10, name: '研发一组', departmentId: 1 },
          { id: 20, name: '质量一组', departmentId: 2 },
        ],
      },
    } as any);
    const user = userEvent.setup();
    render(<ReportPage />);

    expect(await screen.findByRole('tab', { name: '部门报表' })).toBeInTheDocument();
    await waitFor(() => expect(reportApi.getDepartment).toHaveBeenCalledWith(
      1, expect.any(String), expect.any(String), undefined,
    ));
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[1]);
    await user.click(await screen.findByText('研发一组'));
    await user.click(screen.getByRole('button', { name: /查\s*询/ }));
    await waitFor(() => expect(reportApi.getDepartment).toHaveBeenLastCalledWith(
      1, expect.any(String), expect.any(String), 10,
    ));

    await user.click(selects[0]);
    await user.click(await screen.findByText('质量部'));
    expect(selects[1].closest('.ant-select')).toHaveTextContent('按组别过滤');
    await user.click(selects[1]);
    await user.click(await screen.findByText('质量一组'));
    await user.click(screen.getByRole('button', { name: /查\s*询/ }));
    await waitFor(() => expect(reportApi.getDepartment).toHaveBeenLastCalledWith(
      2, expect.any(String), expect.any(String), 20,
    ));
  });

  it('项目报表只展示项目关联组织，并将三级筛选完整传给查询', async () => {
    setUser(['report:access', 'report:view:project']);
    vi.mocked(reportApi.getScope).mockResolvedValue({
      code: 0,
      data: {
        ...scope,
        canViewPersonal: false,
        canViewGroup: false,
        canViewProject: true,
        canViewOvertime: false,
        projects: [{
          id: 31,
          name: '项目甲',
          code: 'A',
          status: 'active',
          moduleSEs: [{
            id: 1,
            group: {
              id: 12,
              name: '模块组',
              departmentId: 2,
              department: { id: 2, name: '质量部' },
            },
          }],
        }],
      },
    } as any);
    const user = userEvent.setup();
    render(<ReportPage />);

    expect(await screen.findByRole('tab', { name: '项目报表' })).toBeInTheDocument();
    await waitFor(() => expect(reportApi.getProject).toHaveBeenCalledWith(
      31, expect.any(String), expect.any(String), { departmentId: undefined, groupId: undefined },
    ));
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[1]);
    await user.click(await screen.findByText('质量部'));
    await user.click(selects[2]);
    await user.click(await screen.findByText('模块组'));
    await user.click(screen.getByRole('button', { name: /查\s*询/ }));

    await waitFor(() => expect(reportApi.getProject).toHaveBeenLastCalledWith(
      31, expect.any(String), expect.any(String), { departmentId: 2, groupId: 12 },
    ));
  });

  it('导出使用当前筛选和日期生成 Excel 下载，并释放临时 URL', async () => {
    setUser(['report:access', 'report:view:group', 'report:export']);
    const createObjectURL = vi.fn(() => 'blob:report');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<ReportPage />);

    await user.click(await screen.findByRole('tab', { name: '组别报表' }));
    await user.click(screen.getByRole('button', { name: /导出Excel/ }));
    await waitFor(() => expect(request.get).toHaveBeenCalledWith('/reports/export/group', {
      params: expect.objectContaining({
        groupId: 10,
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
      responseType: 'blob',
    }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:report'));
  });
});
