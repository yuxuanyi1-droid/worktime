import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Spin, Result, Button, message } from 'antd';
import { authApi } from '../../api/auth';
import { useAuthStore } from '../../stores/authStore';

/**
 * OIDC 回调页：IdP 认证完成后回跳到这里（/oidc/callback?code=xxx&state=xxx）。
 *
 * 登录/绑定意图（mode/provider/redirect）由发起方（Login/Profile 页）在跳转 IdP 前
 * 写入 sessionStorage，本页读取后据此决定换 token（登录）还是写绑定（绑定）。
 *
 * state 是后端 HMAC 签名的完整 token，前端只透传不解析。
 */
const SS_KEY = 'oidc_pending_intent';

export function setOidcIntent(intent: { mode: 'login' | 'bind'; provider: string; redirect?: string }) {
  sessionStorage.setItem(SS_KEY, JSON.stringify(intent));
}

/**
 * 计算前端自身的基地址（origin + __BASE_PATH__），作为 OAuth redirect_uri 的根。
 * dev 下前端在 5174、后端在 3001，必须传前端地址，否则 IdP 回跳到后端端口导致 SPA 加载不到。
 */
export function getRedirectUriBase(): string {
  return `${window.location.origin}${__BASE_PATH__ || ''}`;
}

export default function OidcCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    void handleCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCallback() {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    if (!code || !state) {
      setError('回调参数缺失（code/state），请重新发起登录');
      return;
    }

    // 从 sessionStorage 取发起方记录的意图
    let intent: { mode: 'login' | 'bind'; provider: string; redirect?: string } | null = null;
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (raw) {
        intent = JSON.parse(raw);
        sessionStorage.removeItem(SS_KEY);
      }
    } catch {
      // ignore
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
      if (intent.mode === 'login' && 'token' in res.data) {
        setAuth(res.data.token, res.data.user);
        message.success('登录成功');
        navigate(intent.redirect || '/');
        return;
      }

      // 绑定模式：响应里有 provider/providerLabel
      if (intent.mode === 'bind') {
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
          title="第三方登录失败"
          subTitle={error}
          extra={[
            <Button key="login" type="primary" onClick={() => navigate('/login')}>
              返回登录
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
