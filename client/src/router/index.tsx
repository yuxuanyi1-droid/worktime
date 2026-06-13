import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { usePermission } from '../hooks/usePermission';
import MainLayout from '../components/Layout/MainLayout';
import { Result, Button, Spin } from 'antd';

const Login = lazy(() => import('../pages/Login'));
const Dashboard = lazy(() => import('../pages/Dashboard'));
const Timesheet = lazy(() => import('../pages/Timesheet'));
const Overtime = lazy(() => import('../pages/Overtime'));
const WeeklyReportPage = lazy(() => import('../pages/WeeklyReport'));
const Approval = lazy(() => import('../pages/Approval'));
const ApprovalDetailPage = lazy(() => import('../pages/Approval').then((module) => ({ default: module.ApprovalDetailPage })));
const Report = lazy(() => import('../pages/Report'));
const PermissionRequestPage = lazy(() => import('../pages/PermissionRequest'));
const System = lazy(() => import('../pages/System'));
const ProjectPage = lazy(() => import('../pages/Project'));
const ProfilePage = lazy(() => import('../pages/Profile'));
const NotificationCenter = lazy(() => import('../pages/NotificationCenter'));


function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  if (!token) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

/** 权限路由守卫 */
function PermissionRoute({ children, permission }: { children: React.ReactNode; permission: string }) {
  const { hasPermission } = usePermission();
  if (!hasPermission(permission)) {
    return (
      <Result
        status="403"
        title="无权限"
        subTitle="您没有访问此页面的权限，请联系管理员"
        extra={<Button type="primary" onClick={() => window.history.back()}>返回</Button>}
      />
    );
  }
  return <>{children}</>;
}

/** 角色路由守卫 */
function RoleRoute({ children, roles }: { children: React.ReactNode; roles: string[] }) {
  const { hasRole } = usePermission();
  if (!hasRole(...roles)) {
    return (
      <Result
        status="403"
        title="无权限"
        subTitle="您没有访问此页面的权限，请联系管理员"
        extra={<Button type="primary" onClick={() => window.history.back()}>返回</Button>}
      />
    );
  }
  return <>{children}</>;
}

export default function AppRouter() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>}>
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <MainLayout />
          </PrivateRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="timesheet" element={<PermissionRoute permission="timesheet:read"><Timesheet /></PermissionRoute>} />
        <Route path="overtime" element={<PermissionRoute permission="overtime:read"><Overtime /></PermissionRoute>} />
        <Route path="weekly-report" element={<PermissionRoute permission="weekly_report:read"><WeeklyReportPage /></PermissionRoute>} />
        <Route path="approval" element={<Approval />} />
        <Route path="approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} />
        <Route path="report" element={<PermissionRoute permission="report:access"><Report /></PermissionRoute>} />
        <Route path="permission-request" element={<PermissionRoute permission="permission_request:access"><PermissionRequestPage /></PermissionRoute>} />
        <Route path="project" element={<ProjectPage />} />
        <Route path="system" element={<PermissionRoute permission="system:read"><System /></PermissionRoute>} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="notifications" element={<NotificationCenter />} />
        <Route path="*" element={
          <Result
            status="404"
            title="页面不存在"
            subTitle="你访问的页面不存在或链接已失效"
            extra={<Button type="primary" onClick={() => window.location.href = '/'}>返回首页</Button>}
          />
        } />
      </Route>
      </Routes>
    </Suspense>
  );
}
