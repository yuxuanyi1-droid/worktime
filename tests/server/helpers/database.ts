import { DataSource } from 'typeorm';
import { newDb } from 'pg-mem';
import { SubmissionSequence } from '@server/entities/SubmissionSequence';

/**
 * 测试专用 DataSource（内存 PostgreSQL，每个测试文件隔离）。
 *
 * 用法（在测试文件顶部）：
 *   import { describe, it, expect, beforeEach } from 'vitest';
 *   import { setupTestDb, getTestDataSource } from '../test/setup';
 *   beforeEach(async () => { await setupTestDb(); });
 *
 * 内存库随进程退出自动销毁，互不影响。
 */
let dataSource: DataSource | null = null;

export async function setupTestDb(): Promise<DataSource> {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }
  // 动态导入所有实体（避免与生产 AppDataSource 冲突）
  const entities = await loadEntities();
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  memoryDb.public.registerFunction({
    name: 'current_database',
    implementation: () => 'worktime_test',
  });
  memoryDb.public.registerFunction({
    name: 'version',
    implementation: () => 'PostgreSQL 16.0 (pg-mem)',
  });
  dataSource = memoryDb.adapters.createTypeormDataSource({
    type: 'postgres',
    entities,
    synchronize: true, // 测试进程内的临时库，可快速按实体建表
  });
  await dataSource.initialize();
  // 初始化序列表单行
  await dataSource.getRepository(SubmissionSequence).save({ id: 1, currentValue: 0 });
  return dataSource;
}

export function getTestDataSource(): DataSource {
  if (!dataSource) throw new Error('测试 DB 未初始化，请先调用 setupTestDb()');
  return dataSource;
}

export async function teardownTestDb(): Promise<void> {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
    dataSource = null;
  }
}

// 加载全部实体（与 config/database.ts 保持一致）
async function loadEntities() {
  const { User } = await import('@server/entities/User');
  const { Department } = await import('@server/entities/Department');
  const { Group } = await import('@server/entities/Group');
  const { Role } = await import('@server/entities/Role');
  const { Permission } = await import('@server/entities/Permission');
  const { Project } = await import('@server/entities/Project');
  const { Timesheet } = await import('@server/entities/Timesheet');
  const { OvertimeApplication } = await import('@server/entities/OvertimeApplication');
  const { WeeklyReport } = await import('@server/entities/WeeklyReport');
  const { ApprovalRecord } = await import('@server/entities/ApprovalRecord');
  const { ProjectSE } = await import('@server/entities/ProjectSE');
  const { ProjectWorkloadAllocation } = await import('@server/entities/ProjectWorkloadAllocation');
  const { ApprovalFlow } = await import('@server/entities/ApprovalFlow');
  const { ApprovalFlowStep } = await import('@server/entities/ApprovalFlowStep');
  const { ApprovalFlowVersion } = await import('@server/entities/ApprovalFlowVersion');
  const { ApprovalInstance } = await import('@server/entities/ApprovalInstance');
  const { ApprovalTask } = await import('@server/entities/ApprovalTask');
  const { SystemSetting } = await import('@server/entities/SystemSetting');
  const { Notification } = await import('@server/entities/Notification');
  const { AuditLog } = await import('@server/entities/AuditLog');
  const { Announcement } = await import('@server/entities/Announcement');
  const { AnnouncementRead } = await import('@server/entities/AnnouncementRead');
  const { PermissionRequest } = await import('@server/entities/PermissionRequest');
  const { UserPermissionGrant } = await import('@server/entities/UserPermissionGrant');
  const { UserExternalIdentity } = await import('@server/entities/UserExternalIdentity');
  const { PersonalAccessToken } = await import('@server/entities/PersonalAccessToken');
  return [
    User, Department, Group, Role, Permission, Project,
    Timesheet, OvertimeApplication, WeeklyReport,
    ApprovalRecord, ProjectSE, ProjectWorkloadAllocation, ApprovalFlow, ApprovalFlowStep,
    ApprovalFlowVersion, ApprovalInstance, ApprovalTask,
    SystemSetting, Notification, AuditLog, Announcement, AnnouncementRead,
    PermissionRequest, UserPermissionGrant, SubmissionSequence,
    UserExternalIdentity,
    PersonalAccessToken,
  ];
}
