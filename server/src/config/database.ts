import 'reflect-metadata';
import { DataSource } from 'typeorm';
import path from 'path';
import { User } from '../entities/User';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Role } from '../entities/Role';
import { Permission } from '../entities/Permission';
import { Project } from '../entities/Project';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { ProjectSE } from '../entities/ProjectSE';
import { ProjectWorkloadAllocation } from '../entities/ProjectWorkloadAllocation';
import { ApprovalFlow } from '../entities/ApprovalFlow';
import { ApprovalFlowStep } from '../entities/ApprovalFlowStep';
import { ApprovalFlowVersion } from '../entities/ApprovalFlowVersion';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { ApprovalTask } from '../entities/ApprovalTask';
import { SystemSetting } from '../entities/SystemSetting';
import { Notification } from '../entities/Notification';
import { AuditLog } from '../entities/AuditLog';
import { Announcement } from '../entities/Announcement';
import { AnnouncementRead } from '../entities/AnnouncementRead';
import { PermissionRequest } from '../entities/PermissionRequest';
import { UserPermissionGrant } from '../entities/UserPermissionGrant';
import { SubmissionSequence } from '../entities/SubmissionSequence';
import { UserExternalIdentity } from '../entities/UserExternalIdentity';
import { InitSchema1700000000000 } from '../migrations/1700000000000-InitSchema';
import { PrecisionAndIndexes1700000000001 } from '../migrations/1700000000001-PrecisionAndIndexes';
import { CountersignSupport1700000000002 } from '../migrations/1700000000002-CountersignSupport';
import { RootGroupId1700000000003 } from '../migrations/1700000000003-RootGroupId';

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/worktime.db');
// 默认关闭 synchronize（防止生产环境自动改表丢数据）；
// 仅当显式设置 TYPEORM_SYNCHRONIZE=true 时才开启（开发临时调试用）。
// 首次建表由 ensureSchema() 负责（空库时同步一次，已有库不干预）；
// schema 变更走 migration（见 src/migrations/）。
const shouldSynchronize = process.env.TYPEORM_SYNCHRONIZE === 'true';

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: dbPath,
  synchronize: shouldSynchronize,
  logging: false,
  entities: [
    User, Department, Group, Role, Permission, Project,
    Timesheet, OvertimeApplication, WeeklyReport,
    ApprovalRecord, ProjectSE, ProjectWorkloadAllocation, ApprovalFlow, ApprovalFlowStep,
    ApprovalFlowVersion, ApprovalInstance, ApprovalTask,
    SystemSetting, Notification, AuditLog, Announcement, AnnouncementRead,
    PermissionRequest, UserPermissionGrant,
    SubmissionSequence,
    UserExternalIdentity,
  ],
  migrations: [InitSchema1700000000000, PrecisionAndIndexes1700000000001, CountersignSupport1700000000002, RootGroupId1700000000003],
  subscribers: [],
  prepareDatabase: (db: any) => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  },
});

/**
 * 确保 schema 存在：
 * - 库为空（无任何业务表）→ 根据实体元数据建表（一次性，幂等）
 * - 库已有表 → 不干预，避免覆盖或改动已有数据
 * - 始终运行 migration（补齐新增实体表，如 submission_sequences）
 *
 * 应在 AppDataSource.initialize() 之后、业务逻辑之前调用（见 app.ts / seed.ts）。
 * 这取代了原先常开的 synchronize，做到「首次自动建表 + 后续不自动改表 + migration 平滑升级」。
 */
export async function ensureSchema(): Promise<void> {
  const queryRunner = AppDataSource.createQueryRunner();
  try {
    const tables = await queryRunner.getTables();
    // 排除 TypeORM 系统表（migrations 记录、typeorm_metadata、sqlite_sequence）
    const SYSTEM_TABLES = new Set(['migrations', 'typeorm_metadata', 'sqlite_sequence']);
    const hasEntityTable = tables.some((t) => !SYSTEM_TABLES.has(t.name));
    if (!hasEntityTable) {
      await AppDataSource.synchronize(false);
    }
  } finally {
    await queryRunner.release();
  }
  // 运行 migration：补齐新增实体表（IF NOT EXISTS 幂等），由 migrations 表跟踪版本
  await AppDataSource.runMigrations();
}
