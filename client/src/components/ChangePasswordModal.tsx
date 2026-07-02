import { Modal, Form, Input, message } from 'antd';
import { authApi } from '../api/auth';
import { useAuthStore } from '../stores/authStore';
import { showError } from '../utils/request';

interface ChangePasswordModalProps {
  open: boolean;
  /** 强制模式：初始密码/管理员重置后必须改密，不允许取消 */
  forced?: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * 修改密码弹框（Profile 页与首登强制改密共用）。
 * forced=true 时隐藏取消按钮并禁止 mask/esc 关闭，强制用户完成改密。
 */
export default function ChangePasswordModal({ open, forced = false, onClose, onSuccess }: ChangePasswordModalProps) {
  const [form] = Form.useForm();

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      await authApi.changePassword({ oldPassword: values.oldPassword, newPassword: values.newPassword });
      // 改密后 tokenVersion+1 会使当前 token 失效，后端强制重新登录；这里清除本地登录态并跳登录页
      useAuthStore.getState().clearAuth();
      message.success('密码修改成功，请使用新密码重新登录');
      form.resetFields();
      onSuccess?.();
      onClose();
      window.location.href = '/login';
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败，不提示
      showError(error, '密码修改失败');
    }
  };

  return (
    <Modal
      title="修改密码"
      open={open}
      onOk={handleSubmit}
      onCancel={forced ? undefined : () => { form.resetFields(); onClose(); }}
      maskClosable={!forced}
      keyboard={!forced}
      closable={!forced}
      okText="确认修改"
      cancelText={forced ? undefined : '取消'}
    >
      {forced && (
        <div style={{ marginBottom: 16, padding: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 4 }}>
          <div>检测到您使用的是初始密码，请先修改密码后再继续操作。</div>
          <div style={{ marginTop: 8 }}>
            <a onClick={() => { useAuthStore.getState().clearAuth(); window.location.href = '/login'; }}>返回登录页</a>
          </div>
        </div>
      )}
      <Form form={form} layout="vertical">
        <Form.Item label="原密码" name="oldPassword" rules={[{ required: true, message: '请输入原密码' }]}>
          <Input.Password placeholder="请输入原密码" autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          label="新密码"
          name="newPassword"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 8, message: '密码至少 8 位' },
            { pattern: /(?=.*[a-zA-Z])(?=.*\d)/, message: '密码必须同时包含字母和数字' },
          ]}
          extra="至少 8 位，需同时包含字母和数字"
        >
          <Input.Password placeholder="请输入新密码" autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          label="确认新密码"
          name="confirmPassword"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: '请确认新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
        >
          <Input.Password placeholder="请再次输入新密码" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
