import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import OidcCallbackPage, { setOidcIntent } from '@client/pages/OidcCallback';
import { authApi } from '@client/api/auth';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/auth', () => ({
  authApi: { oidcCallback: vi.fn() },
}));

function renderCallback(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/oidc/callback" element={<OidcCallbackPage />} />
        <Route path="/" element={<div>安全首页</div>} />
        <Route path="/profile" element={<div>个人信息目标页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OIDC 回调页面', () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null });
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('缺少 code/state 时展示可恢复错误，不调用后端', async () => {
    renderCallback('/oidc/callback?code=only-code');
    expect(await screen.findByText('第三方登录失败')).toBeInTheDocument();
    expect(screen.getByText(/回调参数缺失/)).toBeInTheDocument();
    expect(authApi.oidcCallback).not.toHaveBeenCalled();
  });

  it('登录成功后保存身份，并阻止外部 redirect 形成开放跳转', async () => {
    setOidcIntent({ mode: 'login', provider: 'authentik', redirect: 'https://evil.example.com' });
    vi.mocked(authApi.oidcCallback).mockResolvedValue({
      code: 0,
      data: {
        token: 'new-token',
        redirect: '//server-returned-evil.example',
        user: {
          id: 1,
          username: 'oidc-user',
          realName: 'OIDC 用户',
          department: null,
          group: null,
          roles: [],
          permissions: [],
        },
      },
    });
    renderCallback('/oidc/callback?code=code-value&state=state-value');

    expect(await screen.findByText('安全首页')).toBeInTheDocument();
    expect(useAuthStore.getState()).toMatchObject({ token: 'new-token' });
    expect(authApi.oidcCallback).toHaveBeenCalledWith('authentik', expect.objectContaining({
      code: 'code-value', state: 'state-value',
    }));
  });

  it('绑定成功后进入个人信息页并清除一次性意图', async () => {
    setOidcIntent({ mode: 'bind', provider: 'siam' });
    vi.mocked(authApi.oidcCallback).mockResolvedValue({
      code: 0,
      data: { provider: 'siam', providerLabel: 'OPPO SIAM' },
    });
    renderCallback('/oidc/callback?code=bind-code&state=bind-state');

    expect(await screen.findByText('个人信息目标页')).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('oidc_pending_intent')).toBeNull());
  });

  it('身份源拒绝绑定授权时展示准确提示并返回个人信息页', async () => {
    setOidcIntent({ mode: 'bind', provider: 'siam' });
    const user = userEvent.setup();
    renderCallback('/oidc/callback?error=access_denied&error_description=user%20cancelled');

    expect(await screen.findByText('第三方账号绑定失败')).toBeInTheDocument();
    expect(screen.getByText(/取消或拒绝/)).toBeInTheDocument();
    expect(authApi.oidcCallback).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '返回个人信息重新绑定' }));
    expect(await screen.findByText('个人信息目标页')).toBeInTheDocument();
  });

  it('回调请求失败后销毁授权码意图并提供重新发起入口', async () => {
    setOidcIntent({ mode: 'login', provider: 'siam', redirect: '/reports' });
    vi.mocked(authApi.oidcCallback).mockRejectedValue({ response: { data: { message: '授权码已过期' } } });
    renderCallback('/oidc/callback?code=expired&state=signed');

    expect(await screen.findByText('授权码已过期')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回登录重新发起' })).toBeInTheDocument();
    expect(sessionStorage.getItem('oidc_pending_intent')).toBeNull();
  });

  it('畸形或过期的浏览器意图不会决定 provider', async () => {
    sessionStorage.setItem('oidc_pending_intent', JSON.stringify({
      mode: 'login', provider: '../evil', createdAt: Date.now(),
    }));
    renderCallback('/oidc/callback?code=code&state=state');

    expect(await screen.findByText(/登录意图已丢失/)).toBeInTheDocument();
    expect(authApi.oidcCallback).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('oidc_pending_intent')).toBeNull();
  });
});
