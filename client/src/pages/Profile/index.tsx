import { useEffect, useState } from 'react';
import { Card, Form, Input, Button, message, Typography, Divider, Descriptions, Modal } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../stores/authStore';
import request from '../../utils/request';

const { Title } = Typography;

export default function ProfilePage() {
  const { user, setAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [pwdModalOpen, setPwdModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm();

  useEffect(() => {
    if (user) {
      form.setFieldsValue({
        realName: user.realName,
        email: user.email || '',
        phone: user.phone || '',
      });
    }
  }, [user]);

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
    } catch {
      message.error('更新失败');
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

      <Card title="编辑信息" style={{ borderRadius: 12, marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Form.Item label="姓名" name="realName" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input prefix={<UserOutlined />} placeholder="姓名" />
          </Form.Item>
          <Form.Item label="邮箱" name="email" rules={[{ type: 'email', message: '请输入有效邮箱地址' }]}>
            <Input placeholder="邮箱地址" />
          </Form.Item>
          <Form.Item label="手机号" name="phone" rules={[{ pattern: /^1\d{10}$/, message: '请输入有效手机号' }]}>
            <Input placeholder="手机号" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSave} loading={loading}>
              保存修改
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card style={{ borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>修改登录密码</span>
          <Button icon={<LockOutlined />} onClick={() => setPwdModalOpen(true)}>
            修改密码
          </Button>
        </div>
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
