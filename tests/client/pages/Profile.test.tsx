import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ProfilePage from '@client/pages/Profile';
import { authApi } from '@client/api/auth';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/auth', () => ({
  authApi: {
    updateProfile: vi.fn(),
    changePassword: vi.fn(),
    oidcVisibleProviders: vi.fn(),
    oidcBindings: vi.fn(),
    oidcLogin: vi.fn(),
    oidcUnbind: vi.fn(),
  },
}));

function setUser(idpManaged = false) {
  useAuthStore.setState({
    token: 'current-token',
    user: {
      id: 1,
      username: 'profile-user',
      realName: '个人用户',
      email: 'user@example.com',
      phone: '13800138000',
      department: null,
      group: null,
      roles: [],
      permissions: [],
      idpManaged,
    },
  });
  localStorage.setItem('token', 'current-token');
}

describe('个人信息页面', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(authApi.oidcVisibleProviders).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(authApi.oidcBindings).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(authApi.changePassword).mockResolvedValue({ code: 0 });
  });

  it('修改密码与后端保持至少 8 位，并在成功后立即清理已失效登录态', async () => {
    setUser(false);
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /修改密码/ }));
    await user.type(screen.getByLabelText('原密码'), 'old-password');
    await user.type(screen.getByLabelText('新密码'), 'new-password');
    await user.type(screen.getByLabelText('确认新密码'), 'new-password');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    await waitFor(() => expect(authApi.changePassword).toHaveBeenCalledWith({
      oldPassword: 'old-password',
      newPassword: 'new-password',
    }));
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null });
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('SSO 管控账号只读展示，不出现本地保存和修改密码入口', async () => {
    setUser(true);
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByText(/由 SSO 管控/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存修改' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /修改密码/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('姓名')).toHaveAttribute('readonly');
  });

  it('保存本地资料时直接使用后端返回的新档案更新登录态', async () => {
    setUser(false);
    const updatedUser = {
      ...useAuthStore.getState().user!,
      realName: '修改后的姓名',
      email: 'updated@example.com',
    };
    vi.mocked(authApi.updateProfile).mockResolvedValue({ code: 0, data: updatedUser });
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    const nameInput = screen.getByLabelText('姓名');
    await user.clear(nameInput);
    await user.type(nameInput, '修改后的姓名');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(authApi.updateProfile).toHaveBeenCalledWith({
      realName: '修改后的姓名',
      email: 'user@example.com',
      phone: '13800138000',
    }));
    expect(useAuthStore.getState().user?.realName).toBe('修改后的姓名');
    expect(useAuthStore.getState().token).toBe('current-token');
  });

  it('已绑定的 JIT 主身份源只读展示，不能发起解绑', async () => {
    setUser(true);
    vi.mocked(authApi.oidcVisibleProviders).mockResolvedValue({
      code: 0,
      data: [{ name: 'siam', label: 'OPPO SIAM', type: 'siam', jit: true }],
    });
    vi.mocked(authApi.oidcBindings).mockResolvedValue({
      code: 0,
      data: [{
        id: 9,
        provider: 'siam',
        providerLabel: 'OPPO SIAM',
        externalUsername: '10001',
        jit: true,
        boundAt: '2026-07-22T00:00:00.000Z',
      }],
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByText(/主登录方式 · 10001/)).toBeInTheDocument();
    expect(screen.getByText('由身份源维护')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '解绑' })).not.toBeInTheDocument();
  });

  it('补充身份源发起绑定失败时不会残留可被后续回调误用的意图', async () => {
    setUser(false);
    vi.mocked(authApi.oidcVisibleProviders).mockResolvedValue({
      code: 0,
      data: [{ name: 'dingtalk', label: '钉钉', type: 'dingtalk', jit: false }],
    });
    vi.mocked(authApi.oidcLogin).mockImplementation(async () => {
      expect(JSON.parse(sessionStorage.getItem('oidc_pending_intent') || '{}')).toMatchObject({
        mode: 'bind', provider: 'dingtalk',
      });
      throw new Error('network failed');
    });
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /绑定/ }));

    await waitFor(() => expect(authApi.oidcLogin).toHaveBeenCalledWith('dingtalk', expect.objectContaining({
      mode: 'bind',
    })));
    expect(sessionStorage.getItem('oidc_pending_intent')).toBeNull();
  });

  it('绑定信息加载失败时明确提示并允许重试', async () => {
    setUser(false);
    vi.mocked(authApi.oidcBindings).mockRejectedValueOnce({ response: { data: { message: '绑定服务暂不可用' } } });
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByText('绑定服务暂不可用')).toBeInTheDocument();
    vi.mocked(authApi.oidcBindings).mockResolvedValue({ code: 0, data: [] });
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => expect(authApi.oidcBindings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/暂无可绑定的第三方账号/)).toBeInTheDocument();
  });
});
