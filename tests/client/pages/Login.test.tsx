import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Login from '@client/pages/Login';
import { authApi } from '@client/api/auth';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/auth', () => ({
  authApi: {
    login: vi.fn(),
    oidcVisibleProviders: vi.fn(),
    oidcLogin: vi.fn(),
  },
}));

function CurrentLocation() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderLogin(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<CurrentLocation />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('登录页', () => {
  beforeEach(() => {
    vi.mocked(authApi.oidcVisibleProviders).mockResolvedValue({ code: 0, data: [] });
    sessionStorage.clear();
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('输入框具备可访问名称并支持密码管理器', async () => {
    renderLogin();
    const username = await screen.findByLabelText('用户名');
    const password = screen.getByLabelText('密码');
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
  });

  it('登录成功后保存身份，并把外部 redirect 降级为首页', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      code: 0,
      data: {
        token: 'jwt-token',
        user: {
          id: 1,
          username: 'tester',
          realName: '测试用户',
          department: null,
          group: null,
          roles: [],
          permissions: [],
        },
      },
    });
    const user = userEvent.setup();
    renderLogin('/login?redirect=%2F%2Fevil.example');

    await user.type(await screen.findByLabelText('用户名'), 'tester');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => expect(useAuthStore.getState().token).toBe('jwt-token'));
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('第三方登录未返回跳转地址时清理一次性意图并恢复按钮', async () => {
    vi.mocked(authApi.oidcVisibleProviders).mockResolvedValue({
      code: 0,
      data: [{ name: 'siam', label: 'OPPO SIAM', type: 'siam', jit: false }],
    });
    vi.mocked(authApi.oidcLogin).mockResolvedValue({ code: 0, data: { url: '' } });
    const user = userEvent.setup();
    renderLogin('/login?redirect=%2Freports');

    const ssoButton = await screen.findByRole('button', { name: /OPPO SIAM 登录/ });
    await user.click(ssoButton);

    await waitFor(() => expect(authApi.oidcLogin).toHaveBeenCalledWith('siam', expect.objectContaining({
      mode: 'login', redirect: '/reports',
    })));
    expect(sessionStorage.getItem('oidc_pending_intent')).toBeNull();
    expect(ssoButton).toBeEnabled();
  });

  it('一个 SSO 请求进行中时禁止重复发起其他登录', async () => {
    vi.mocked(authApi.oidcVisibleProviders).mockResolvedValue({
      code: 0,
      data: [
        { name: 'siam', label: 'OPPO SIAM', type: 'siam', jit: false },
        { name: 'dingtalk', label: '钉钉', type: 'dingtalk', jit: false },
      ],
    });
    let resolveRequest!: (value: any) => void;
    vi.mocked(authApi.oidcLogin).mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const user = userEvent.setup();
    renderLogin();

    const siam = await screen.findByRole('button', { name: /OPPO SIAM 登录/ });
    const dingtalk = screen.getByRole('button', { name: /钉钉\s*登录/ });
    await user.click(siam);

    expect(dingtalk).toBeDisabled();
    expect(screen.getByRole('button', { name: /^登\s*录$/ })).toBeDisabled();
    await user.click(dingtalk);
    expect(authApi.oidcLogin).toHaveBeenCalledTimes(1);

    resolveRequest({ code: 0, data: { url: '' } });
    await waitFor(() => expect(dingtalk).toBeEnabled());
  });
});
