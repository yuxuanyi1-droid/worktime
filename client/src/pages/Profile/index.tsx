import { useEffect, useState } from 'react';
import { Alert, Card, Form, Input, Button, message, Typography, Descriptions, Modal, Tag, Space, Spin } from 'antd';
import { UserOutlined, LockOutlined, LinkOutlined, DisconnectOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../api/auth';
import { clearOidcIntent, getRedirectUriBase, setOidcIntent } from '../../utils/oidcIntent';
import type { OidcProviderInfo, OidcBinding } from '../../types';
import { useNavigate } from 'react-router-dom';

const { Title } = Typography;

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, setAuth, clearAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [pwdModalOpen, setPwdModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm();
  // 第三方账号绑定
  const [providers, setProviders] = useState<OidcProviderInfo[]>([]);
  const [bindings, setBindings] = useState<OidcBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [bindLoading, setBindLoading] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      form.setFieldsValue({
        realName: user.realName,
        email: user.email || '',
        phone: user.phone || '',
      });
    }
  }, [user]);

  // 拉取可见 provider + 当前用户绑定列表
  const loadBindings = async () => {
    setBindingsLoading(true);
    setBindingsError(null);
    try {
      const [provRes, bindRes] = await Promise.all([
        authApi.oidcVisibleProviders(),
        authApi.oidcBindings(),
      ]);
      const allProviders = Array.isArray(provRes.data) ? provRes.data : [];
      const allBindings = Array.isArray(bindRes.data) ? bindRes.data : [];
      const boundNames = new Set(allBindings.map((binding) => binding.provider));
      const visibleProviders = allProviders.filter((provider) => !provider.jit || boundNames.has(provider.name));
      const visibleNames = new Set(visibleProviders.map((provider) => provider.name));

      // 已有绑定即使后来被管理员关闭，也应继续展示，用户才能理解当前登录方式并处理补充绑定。
      for (const binding of allBindings) {
        if (!visibleNames.has(binding.provider)) {
          visibleProviders.push({
            name: binding.provider,
            label: binding.providerLabel,
            type: 'oidc',
            jit: binding.jit,
          });
        }
      }
      setProviders(visibleProviders);
      setBindings(allBindings);
    } catch (e: any) {
      setBindingsError(e?.response?.data?.message || '第三方账号信息加载失败');
    } finally {
      setBindingsLoading(false);
    }
  };

  useEffect(() => {
    loadBindings();
  }, []);

  const handleBind = async (provider: OidcProviderInfo) => {
    if (bindLoading) return;
    setBindLoading(provider.name);
    try {
      // 绑定意图存 sessionStorage，回调页据此走绑定分支
      setOidcIntent({ mode: 'bind', provider: provider.name });
      const res = await authApi.oidcLogin(provider.name, {
        mode: 'bind',
        redirectUriBase: getRedirectUriBase(),
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        clearOidcIntent();
        message.error('未获取到第三方绑定地址，请稍后重试');
      }
    } catch {
      clearOidcIntent();
      // 响应拦截器已弹错误
    } finally {
      setBindLoading(null);
    }
  };

  const handleUnbind = (provider: string, label: string) => {
    Modal.confirm({
      title: '解绑确认',
      content: `确定要解绑${label}账号吗？解绑后将无法使用该账号登录本系统。`,
      okText: '解绑',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await authApi.oidcUnbind(provider);
          message.success('已解绑');
          await loadBindings();
        } catch {
          // 响应拦截器已弹错误
        }
      },
    });
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      const profileRes = await authApi.updateProfile(values);
      if (profileRes.data) {
        const token = localStorage.getItem('token')!;
        setAuth(token, profileRes.data);
      }
      message.success('个人信息已更新');
    } catch (e: any) {
      message.error(e?.response?.data?.message || '更新失败');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async () => {
    try {
      // validateFields 触发表单校验（required/min length/两次一致），不通过则抛出
      const values = await pwdForm.validateFields();
      await authApi.changePassword({
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });
      message.success('密码修改成功，请重新登录');
      setPwdModalOpen(false);
      pwdForm.resetFields();
      clearAuth();
      navigate('/login', { replace: true });
    } catch (e: any) {
      // validateFields 失败时 error.errorFields 存在，是表单校验错误，不弹 message
      if (!e?.errorFields) {
        message.error(e?.response?.data?.message || '密码修改失败');
      }
    }
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>个人信息</Title>

      <Card style={{ borderRadius: 12, marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="用户名">{user?.username}</Descriptions.Item>
          <Descriptions.Item label="部门">{user?.department?.name || '-'}</Descriptions.Item>
          <Descriptions.Item label="分组">{user?.group?.name || '-'}</Descriptions.Item>
          <Descriptions.Item label="角色">{user?.roles?.map(r => r.label).join('、') || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="编辑信息"
        extra={user?.idpManaged ? <span style={{ color: '#9A9080', fontSize: 12 }}>由 SSO 管控，信息在身份源修改后下次登录自动同步</span> : undefined}
        style={{ borderRadius: 12, marginBottom: 16 }}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="姓名" name="realName" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input prefix={<UserOutlined />} placeholder="姓名" readOnly={user?.idpManaged} />
          </Form.Item>
          <Form.Item label="邮箱" name="email" rules={[{ type: 'email', message: '请输入有效邮箱地址' }]}>
            <Input placeholder="邮箱地址" readOnly={user?.idpManaged} />
          </Form.Item>
          <Form.Item label="手机号" name="phone" rules={[{ pattern: /^1\d{10}$/, message: '请输入有效手机号' }]}>
            <Input placeholder="手机号" readOnly={user?.idpManaged} />
          </Form.Item>
          {!user?.idpManaged && (
            <Form.Item>
              <Button type="primary" onClick={handleSave} loading={loading}>
                保存修改
              </Button>
            </Form.Item>
          )}
        </Form>
      </Card>

      {!user?.idpManaged && (
        <Card style={{ borderRadius: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>修改登录密码</span>
            <Button icon={<LockOutlined />} onClick={() => setPwdModalOpen(true)}>
              修改密码
            </Button>
          </div>
        </Card>
      )}

      <Card title="第三方账号绑定" style={{ borderRadius: 12, marginBottom: 16 }}>
        <Spin spinning={bindingsLoading}>
          {bindingsError ? (
            <Alert
              type="warning"
              showIcon
              message={bindingsError}
              action={<Button size="small" onClick={() => void loadBindings()}>重试</Button>}
            />
          ) : providers.length === 0 ? (
            <div style={{ color: '#888', fontSize: 13 }}>
              暂无可绑定的第三方账号。如需启用，请联系管理员在「管理 → 系统设置 → OIDC 认证」中开启。
            </div>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {providers.map((p) => {
                const bound = bindings.find((b) => b.provider === p.name);
                return (
                  <div
                    key={p.name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 0',
                    }}
                  >
                    <Space>
                      <Tag color={bound ? 'green' : 'default'}>{p.label}</Tag>
                      {bound ? (
                        <span style={{ color: '#666', fontSize: 13 }}>
                          {p.jit ? '主登录方式' : '已绑定'}
                          {bound.externalUsername ? ` · ${bound.externalUsername}` : ''}
                        </span>
                      ) : (
                        <span style={{ color: '#aaa', fontSize: 13 }}>未绑定</span>
                      )}
                    </Space>
                    {bound && p.jit ? (
                      <Tag color="blue">由身份源维护</Tag>
                    ) : bound ? (
                      <Button
                        size="small"
                        danger
                        icon={<DisconnectOutlined />}
                        onClick={() => handleUnbind(p.name, p.label)}
                      >
                        解绑
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        type="primary"
                        icon={<LinkOutlined />}
                        loading={bindLoading === p.name}
                        disabled={bindLoading !== null && bindLoading !== p.name}
                        onClick={() => handleBind(p)}
                      >
                        绑定
                      </Button>
                    )}
                  </div>
                );
              })}
            </Space>
          )}
        </Spin>
      </Card>

      <Modal
        title="修改密码"
        open={pwdModalOpen}
        onCancel={() => { setPwdModalOpen(false); pwdForm.resetFields(); }}
        onOk={handleChangePassword}
        okText="确认修改"
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item label="原密码" name="oldPassword" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item label="新密码" name="newPassword" rules={[{ required: true, min: 8, message: '密码至少8位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="确认新密码" name="confirmPassword" dependencies={['newPassword']} rules={[
            { required: true, message: '请确认新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
