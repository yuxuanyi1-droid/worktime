import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { authApi } from '../../api/auth';
import { useAuthStore } from '../../stores/authStore';
import { useAppStore } from '../../stores/appStore';

export default function Login() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();
  const { systemName, loadSettings } = useAppStore();

  useEffect(() => {
    // 无 token 时后端会 401，跳过加载（使用默认名称即可）
    if (localStorage.getItem('token')) loadSettings();
  }, [loadSettings]);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await authApi.login(values);
      if (res.data) {
        setAuth(res.data.token, res.data.user);
        message.success('登录成功');
        const redirect = searchParams.get('redirect') || '/';
        navigate(redirect);
      }
    } catch {
      // error handled by interceptor
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#F8F4ED',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* 装饰圆 */}
      <div style={{
        position: 'absolute', width: 500, height: 500, borderRadius: '50%',
        background: 'rgba(107,143,113,0.08)', top: -180, right: -120,
      }} />
      <div style={{
        position: 'absolute', width: 360, height: 360, borderRadius: '50%',
        background: 'rgba(196,149,106,0.08)', bottom: -120, left: -100,
      }} />
      <div style={{
        position: 'absolute', width: 200, height: 200, borderRadius: '50%',
        background: 'rgba(107,143,113,0.06)', top: '40%', left: '10%',
      }} />

      {/* 登录卡片 */}
      <div style={{
        width: 420,
        borderRadius: 24,
        background: '#FDFBF7',
        border: '1px solid #E8E0D4',
        padding: '48px 40px',
        boxShadow: '0 20px 60px rgba(44,36,24,0.06)',
        position: 'relative',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h1 style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 32,
            fontWeight: 900,
            color: '#2C2418',
            marginBottom: 8,
            letterSpacing: '-0.02em',
          }}>
            {systemName}
          </h1>
          <p style={{
            color: '#9A9080',
            fontSize: 14,
            fontWeight: 400,
          }}>
            工时管理系统
          </p>
        </div>

        <Form onFinish={onFinish} size="large" autoComplete="off">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input
              prefix={<UserOutlined style={{ color: '#9A9080' }} />}
              placeholder="用户名"
              style={{
                borderRadius: 12,
                background: '#F8F4ED',
                border: '1px solid #E8E0D4',
                padding: '10px 14px',
              }}
            />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined style={{ color: '#9A9080' }} />}
              placeholder="密码"
              style={{
                borderRadius: 12,
                background: '#F8F4ED',
                border: '1px solid #E8E0D4',
                padding: '10px 14px',
              }}
            />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              style={{
                height: 50,
                borderRadius: 12,
                fontWeight: 600,
                fontSize: 15,
                background: '#2C2418',
                borderColor: '#2C2418',
              }}
            >
              登 录
            </Button>
          </Form.Item>
        </Form>

        {import.meta.env.DEV && (
          <div style={{ textAlign: 'center', color: '#B0A898', fontSize: 12 }}>
            默认账号: admin / 123456
          </div>
        )}
      </div>
    </div>
  );
}
