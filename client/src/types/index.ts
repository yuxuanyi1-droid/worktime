// 通用分页响应
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

// 用户相关
export interface UserInfo {
  id: number;
  username: string;
  realName: string;
  email?: string;
  phone?: string;
  department: { id: number; name: string } | null;
  group: { id: number; name: string } | null;
  roles: { id: number; name: string; label: string }[];
  permissions: string[];
}

export interface LoginResult {
  token: string;
  user: UserInfo;
}

// 部门
export interface Department {
  id: number;
  name: string;
  description?: string;
  sortOrder: number;
  leader?: { id: number; realName: string } | null;
  leaderId?: number | null;
  createdAt: string;
}

// 分组（多层级树形）
export interface Group {
  id: number;
  name: string;
  description?: string;
  department?: Department | null;
  departmentId?: number | null;
  parentId?: number | null;
  parent?: { id: number; name: string } | null;
  children?: Group[];
  leader?: { id: number; realName: string } | null;
  leaderId?: number | null;
  level: number;
  path?: string;
  sortOrder: number;
}

// 角色
export interface Role {
  id: number;
  name: string;
  label: string;
  description?: string;
  permissions: Permission[];
}

export interface Permission {
  id: number;
  code: string;
  name: string;
  module: string;
  action: string;
  grantable?: boolean;
  scopeTypes?: string[];
}

// 项目
export interface Project {
  id: number;
  name: string;
  code: string;
  description?: string;
  status: string; // active=进行中, completed=已完成, suspended=已中止, cancelled=已取消
  managers?: { id: number; realName: string }[];
  moduleSEs?: ProjectSE[];
  canUpdate?: boolean;
  canAssignSE?: boolean;
  canAssignManager?: boolean;
  canDelete?: boolean;
}

// 项目状态映射
export const projectStatusMap: Record<string, { label: string; color: string }> = {
  active: { label: '进行中', color: 'green' },
  completed: { label: '已完成', color: 'blue' },
  suspended: { label: '已中止', color: 'orange' },
  cancelled: { label: '已取消', color: 'default' },
};

// 项目SE
export interface ProjectSE {
  id: number;
  projectId: number;
  userId: number;
  groupId: number;
  user?: { id: number; realName: string } | null;
  group?: {
    id: number;
    name: string;
    departmentId?: number | null;
    department?: { id: number; name: string } | null;
  } | null;
  userName?: string;
  groupName?: string;
}

// 工时
export interface Timesheet {
  id: number;
  userId: number;
  departmentSnapshotId?: number | null;
  departmentSnapshotName?: string | null;
  groupSnapshotId?: number | null;
  groupSnapshotName?: string | null;
  projectId: number;
  project?: Project;
  date: string;
  hours: number;
  description?: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'deprecated';
  currentStep: number;
  totalSteps: number;
  approvalFlowId?: number | null;
  previousGroupId?: number | null;
  submissionGroupId?: number | null;
  createdAt: string;
  updatedAt: string;
}

// 加班
export interface OvertimeApplication {
  id: number;
  userId: number;
  departmentSnapshotId?: number | null;
  departmentSnapshotName?: string | null;
  groupSnapshotId?: number | null;
  groupSnapshotName?: string | null;
  projectId?: number | null;
  project?: { id: number; name: string } | null;
  date: string;
  overtimeType: 'weekend' | 'holiday' | 'weekday';
  hours: number;
  reason?: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  currentStep: number;
  totalSteps: number;
  createdAt: string;
  updatedAt: string;
}

// 周报
export interface WeeklyReport {
  id: number;
  userId: number;
  weekStart: string;
  weekEnd: string;
  content?: string;
  summary?: string;
  totalHours: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  currentStep: number;
  totalSteps: number;
  createdAt: string;
  updatedAt: string;
}

// 审批
export interface ApprovalItem {
  targetType: 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';
  targetId: number;
  instanceId?: number | null;
  taskId?: number | null;
  title: string;
  applicant: string;
  applicantId?: number;
  department?: string;
  date?: string;
  hours?: number;
  description?: string;
  overtimeType?: string;
  reason?: string;
  weekStart?: string;
  weekEnd?: string;
  totalHours?: number;
  summary?: string;
  permissionCode?: string;
  permissionName?: string;
  scopeType?: string;
  scopeId?: number | null;
  scopeName?: string | null;
  expiresAt?: string | null;
  currentStep?: number;
  totalSteps?: number;
  currentStepLabel?: string;
  currentStepApprover?: string;
  projectId?: number;
  createdAt: string;
}

export interface ApprovalRecord {
  id: number;
  targetType: string;
  targetId: number;
  approverId: number;
  approverName: string;
  action: 'approve' | 'reject' | 'cc' | 'withdraw';
  comment?: string;
  stepOrder?: number;
  stepType?: string;
  stepLabel?: string;
  createdAt: string;
}

// 审批流程
export interface ApprovalFlow {
  id: number;
  name: string;
  type: 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';
  description?: string;
  isDefault: boolean;
  enabled: boolean;
  steps: ApprovalFlowStep[];
}

export interface ApprovalFlowStep {
  id?: number;
  flowId?: number;
  stepOrder: number;
  stepType: 'group_leader' | 'parent_leader' | 'dept_leader' | 'module_se' | 'project_manager' | 'custom';
  label: string;
  parentLevel?: number;
  customApproverId?: number | null;
}

// 报表
export interface DashboardData {
  monthHours: number;
  overtimeHours: number;
  pendingCount: number;
  trend: { date: string; hours: number }[];
}

export interface PersonalReport {
  totalHours: number;
  byProject: Record<string, { hours: number; count: number }>;
  byDate: Record<string, number>;
}

export interface DepartmentReport {
  totalHours: number;
  byUser: Record<string, { hours: number; count: number }>;
  byProject: Record<string, { hours: number; count?: number }>;
  byDate: Record<string, number>;
  byGroup: Record<string, { hours: number; count: number }>;
  byDepartment?: Record<string, { hours: number; count: number }>;
}

export interface GroupReport {
  totalHours: number;
  byUser: Record<string, { hours: number; count: number }>;
  byProject: Record<string, { hours: number; count?: number }>;
  byDate: Record<string, number>;
  byGroup: Record<string, { hours: number; count: number }>;
}

export interface ProjectReport {
  totalHours: number;
  byUser: Record<string, { hours: number; count: number }>;
  byProject: Record<string, { hours: number; count?: number }>;
  byDate: Record<string, number>;
  byDepartment: Record<string, { hours: number; count: number }>;
  byGroup: Record<string, { hours: number; count: number }>;
  filters?: {
    departments: { id: number; name: string }[];
    groups: { id: number; name: string; departmentId: number | null }[];
  };
}

export interface ReportScope {
  canViewPersonal: boolean;
  canViewDepartment: boolean;
  canViewGroup: boolean;
  canViewProject: boolean;
  canViewOvertime: boolean;
  departments: Department[];
  groups: Group[];
  projects: Project[];
}

export interface OvertimeReport {
  totalHours: number;
  byType: Record<string, number>;
  byUser: Record<string, number>;
  byGroup?: Record<string, { hours: number }>;
}

// 状态标签
export const statusMap: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  submitted: { label: '审批中', color: 'processing' },
  approved: { label: '已审批', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
  withdrawn: { label: '已撤回', color: 'default' },
  deprecated: { label: '已废弃', color: 'warning' },
};

export const overtimeTypeMap: Record<string, string> = {
  weekend: '周末加班',
  holiday: '节假日加班',
  weekday: '工作日加班',
};

// 审批步骤类型映射
export const stepTypeMap: Record<string, string> = {
  group_leader: '直属负责人',
  parent_leader: '上级负责人',
  dept_leader: '部门负责人',
  module_se: '模块SE',
  project_manager: '项目管理员',
  custom: '自定义审批人',
};

export interface PermissionRequestItem {
  id: number;
  applicantId: number;
  applicant?: { id: number; realName: string } | null;
  permissionCode: string;
  permissionName: string;
  scopeType: 'self' | 'group' | 'department' | 'project' | 'global';
  scopeId?: number | null;
  scopeName?: string | null;
  reason: string;
  expiresAt?: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  currentStep: number;
  totalSteps: number;
  approvalInstanceId?: number | null;
  grantId?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserPermissionGrant {
  id: number;
  userId: number;
  user?: { id: number; realName: string; username: string } | null;
  permissionCode: string;
  scopeType: 'self' | 'group' | 'department' | 'project' | 'global';
  scopeId?: number | null;
  scopeName?: string | null;
  source: 'request' | 'manual' | 'system';
  status: 'active' | 'revoked' | 'expired';
  startsAt?: string | null;
  expiresAt?: string | null;
  approvalInstanceId?: number | null;
  requestId?: number | null;
  reason?: string | null;
  createdAt: string;
  updatedAt: string;
}
