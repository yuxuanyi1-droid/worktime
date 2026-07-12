import { useEffect, useState } from 'react';
import { Card, Form, Input, Button, message, Typography, Divider, Descriptions, Modal, Tag, Space, Spin } from 'antd';
import { UserOutlined, LockOutlined, LinkOutlined, DisconnectOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../stores/authStore';
import request from '../../utils/request';
import { authApi } from '../../api/auth';
import { setOidcIntent, getRedirectUriBase } from '../OidcCallback';
import type { OidcProviderInfo, OidcBinding } from '../../types';

const { Title } = Typography;

export default function ProfilePage() {
  const { user, setAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [pwdModalOpen, setPwdModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm();
  // 第三方账号绑定
  const [providers, setProviders] = useState<OidcProviderInfo[]>([]);
  const [bindings, setBindings] = useState<OidcBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
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
    try {
      const [provRes, bindRes] = await Promise.all([
        authApi.oidcVisibleProviders().catch(() => ({ code: 0, data: [] as OidcProviderInfo[] })),
        authApi.oidcBindings().catch(() => ({ code: 0, data: [] as OidcBinding[] })),
      ]);
      // 绑定区只显示非 JIT 的 provider（JIT provider 是主登录方式，自动建号无需手动绑定）
      const allProviders = Array.isArray(provRes.data) ? provRes.data : [];
      setProviders(allProviders.filter((p) => !p.jit));
      setBindings(Array.isArray(bindRes.data) ? bindRes.data : []);
    } finally {
      setBindingsLoading(false);
    }
  };

  useEffect(() => {
    loadBindings();
  }, []);

  const handleBind = async (provider: OidcProviderInfo) => {
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
      }
    } catch {
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
      await request.put('/auth/profile', values);
      // 更新本地用户信息
      const profileRes = await request.get<any, { code: number; data: any }>('/auth/profile');
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
      await request.put('/auth/change-password', {
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });
      message.success('密码修改成功');
      setPwdModalOpen(false);
      pwdForm.resetFields();
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
          {providers.length === 0 ? (
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
                          已绑定{bound.externalUsername ? ` · ${bound.externalUsername}` : ''}
                        </span>
                      ) : (
                        <span style={{ color: '#aaa', fontSize: 13 }}>未绑定</span>
                      )}
                    </Space>
                    {bound ? (
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
            <Input.Password />
          </Form.Item>
          <Form.Item label="新密码" name="newPassword" rules={[{ required: true, min: 6, message: '密码至少6位' }]}>
            <Input.Password />
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
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
