import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spin, Result, Button, message } from 'antd';
import { authApi } from '../../api/auth';
import { useAuthStore } from '../../stores/authStore';
import { safeInternalRedirect } from '../../utils/navigation';
import {
  getRedirectUriBase,
  setOidcIntent,
  takeOidcIntent,
  type OidcIntent,
} from '../../utils/oidcIntent';

/**
 * OIDC 回调页：IdP 认证完成后回跳到这里（/oidc/callback?code=xxx&state=xxx）。
 *
 * 登录/绑定意图（mode/provider/redirect）由发起方（Login/Profile 页）在跳转 IdP 前
 * 写入 sessionStorage，本页读取后据此决定换 token（登录）还是写绑定（绑定）。
 *
 * state 是后端 HMAC 签名的完整 token，前端只透传不解析。
 */
// 保留页面原有导出，避免现有调用方在迁移到独立工具模块期间失效。
export { getRedirectUriBase, setOidcIntent };

export default function OidcCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Pick<OidcIntent, 'mode' | 'redirect'>>({ mode: 'login' });
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    void handleCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCallback() {
    const intent = takeOidcIntent();
    if (intent) setRecovery({ mode: intent.mode, redirect: intent.redirect });

    const providerError = searchParams.get('error');
    if (providerError) {
      const description = searchParams.get('error_description')?.trim().slice(0, 300);
      setError(providerError === 'access_denied'
        ? '你已取消或拒绝第三方授权，请重新发起'
        : `身份源返回错误：${description || providerError}`);
      return;
    }

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    if (!code || !state) {
      setError('回调参数缺失（code/state），请重新发起登录');
      return;
    }

    if (!intent) {
      setError('登录意图已丢失，请重新发起');
      return;
    }

    try {
      const res = await authApi.oidcCallback(intent.provider, {
        code,
        state,
        redirectUriBase: getRedirectUriBase(),
      });
      if (!res.data) {
        setError('回调处理失败，未返回数据');
        return;
      }

      // 登录模式：响应里有 token + user
      if ('token' in res.data && typeof res.data.token === 'string') {
        setAuth(res.data.token, res.data.user);
        message.success('登录成功');
        const serverRedirect = 'redirect' in res.data && typeof res.data.redirect === 'string'
          ? res.data.redirect
          : intent.redirect;
        navigate(safeInternalRedirect(serverRedirect));
        return;
      }

      // 绑定模式：响应里有 provider/providerLabel
      if ('provider' in res.data) {
        message.success(`${(res.data as any).providerLabel || '第三方账号'} 绑定成功`);
        navigate('/profile');
        return;
      }

      setError('未知的回调结果');
    } catch (e: any) {
      // 响应拦截器已弹 message；这里给一个可重试的错误页
      const msg = e?.response?.data?.message || e?.message || '回调处理失败';
      setError(msg);
    }
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F8F4ED' }}>
        <Result
          status="warning"
          title={recovery.mode === 'bind' ? '第三方账号绑定失败' : '第三方登录失败'}
          subTitle={error}
          extra={[
            <Button
              key="retry"
              type="primary"
              onClick={() => navigate(recovery.mode === 'bind'
                ? '/profile'
                : `/login?redirect=${encodeURIComponent(safeInternalRedirect(recovery.redirect))}`)}
            >
              {recovery.mode === 'bind' ? '返回个人信息重新绑定' : '返回登录重新发起'}
            </Button>,
            <Button key="home" onClick={() => navigate('/')}>
              返回首页
            </Button>,
          ]}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F8F4ED' }}>
      <Spin tip="正在处理第三方登录…" size="large">
        <div style={{ padding: 50 }} />
      </Spin>
    </div>
  );
}
