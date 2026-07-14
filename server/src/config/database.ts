import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
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
import { PersonalAccessToken } from '../entities/PersonalAccessToken';
import { InitSchema1700000000000 } from '../migrations/1700000000000-InitSchema';
import { PrecisionAndIndexes1700000000001 } from '../migrations/1700000000001-PrecisionAndIndexes';
import { CountersignSupport1700000000002 } from '../migrations/1700000000002-CountersignSupport';
import { RootGroupId1700000000003 } from '../migrations/1700000000003-RootGroupId';
import { PersonalAccessTokens1700000000004 } from '../migrations/1700000000004-PersonalAccessTokens';

/**
 * 数据库类型：'sqlite'（默认，零配置单文件）或 'postgres'（生产，高并发）。
 * 通过 .env 的 DB_TYPE 切换。
 */
const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase() as 'sqlite' | 'postgres';

const shouldSynchronize = process.env.TYPEORM_SYNCHRONIZE === 'true';

const entities = [
  User, Department, Group, Role, Permission, Project,
  Timesheet, OvertimeApplication, WeeklyReport,
  ApprovalRecord, ProjectSE, ProjectWorkloadAllocation, ApprovalFlow, ApprovalFlowStep,
  ApprovalFlowVersion, ApprovalInstance, ApprovalTask,
  SystemSetting, Notification, AuditLog, Announcement, AnnouncementRead,
  PermissionRequest, UserPermissionGrant,
  SubmissionSequence,
  UserExternalIdentity,
  PersonalAccessToken,
];

const migrations = [
  InitSchema1700000000000, PrecisionAndIndexes1700000000001,
  CountersignSupport1700000000002, RootGroupId1700000000003,
  PersonalAccessTokens1700000000004,
];

/**
 * 根据数据库类型构造 DataSourceOptions。
 * - sqlite: 单文件路径，WAL + foreign_keys pragma
 * - postgres: 标准网络连接参数
 */
function buildDataSourceOptions(): DataSourceOptions {
  const common = { entities, migrations, synchronize: shouldSynchronize, logging: false };

  if (dbType === 'postgres') {
    return {
      ...common,
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || 'worktime',
      // 生产建议开启 ssl（按云服务商配置调整）
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }

  // 默认 sqlite
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/worktime.db');
  return {
    ...common,
    type: 'better-sqlite3',
    database: dbPath,
    prepareDatabase: (db: any) => {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
    },
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());

/** 当前数据库类型（供其他模块按库做语法兼容判断） */
export const databaseType = dbType;

/**
 * 确保 schema 存在：
 * - 库为空（无任何业务表）→ 根据实体元数据建表（一次性，幂等）
 * - 库已有表 → 不干预，避免覆盖或改动已有数据
 * - 始终运行 migration（补齐新增实体表，如 submission_sequences）
 *
 * 应在 AppDataSource.initialize() 之后、业务逻辑之前调用（见 app.ts / seed.ts）。
 */
export async function ensureSchema(): Promise<void> {
  const queryRunner = AppDataSource.createQueryRunner();
  try {
    const tables = await queryRunner.getTables();
    // 排除 TypeORM 系统表（各数据库不同：sqlite 有 sqlite_sequence，postgres 无）
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
