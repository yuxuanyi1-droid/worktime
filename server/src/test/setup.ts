import { beforeEach, afterEach } from 'vitest';
import { DataSource } from 'typeorm';
import { SubmissionSequence } from '../entities/SubmissionSequence';

/**
 * 测试专用 DataSource（SQLite 内存库，每个测试文件隔离）。
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
  dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true, // 测试用 synchronize 快速建表
    entities,
    prepareDatabase: (db: any) => {
      db.pragma('foreign_keys = ON');
    },
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
  const { User } = await import('../entities/User');
  const { Department } = await import('../entities/Department');
  const { Group } = await import('../entities/Group');
  const { Role } = await import('../entities/Role');
  const { Permission } = await import('../entities/Permission');
  const { Project } = await import('../entities/Project');
  const { Timesheet } = await import('../entities/Timesheet');
  const { OvertimeApplication } = await import('../entities/OvertimeApplication');
  const { WeeklyReport } = await import('../entities/WeeklyReport');
  const { ApprovalRecord } = await import('../entities/ApprovalRecord');
  const { ProjectSE } = await import('../entities/ProjectSE');
  const { ApprovalFlow } = await import('../entities/ApprovalFlow');
  const { ApprovalFlowStep } = await import('../entities/ApprovalFlowStep');
  const { ApprovalFlowVersion } = await import('../entities/ApprovalFlowVersion');
  const { ApprovalInstance } = await import('../entities/ApprovalInstance');
  const { ApprovalTask } = await import('../entities/ApprovalTask');
  const { SystemSetting } = await import('../entities/SystemSetting');
  const { Notification } = await import('../entities/Notification');
  const { AuditLog } = await import('../entities/AuditLog');
  const { Announcement } = await import('../entities/Announcement');
  const { AnnouncementRead } = await import('../entities/AnnouncementRead');
  const { PermissionRequest } = await import('../entities/PermissionRequest');
  const { UserPermissionGrant } = await import('../entities/UserPermissionGrant');
  return [
    User, Department, Group, Role, Permission, Project,
    Timesheet, OvertimeApplication, WeeklyReport,
    ApprovalRecord, ProjectSE, ApprovalFlow, ApprovalFlowStep,
    ApprovalFlowVersion, ApprovalInstance, ApprovalTask,
    SystemSetting, Notification, AuditLog, Announcement, AnnouncementRead,
    PermissionRequest, UserPermissionGrant, SubmissionSequence,
  ];
}
