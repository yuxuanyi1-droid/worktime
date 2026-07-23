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
import { ApprovalInstanceIdempotency1700000000005 } from '../migrations/1700000000005-ApprovalInstanceIdempotency';
import { SecurePersonalAccessTokens1700000000006 } from '../migrations/1700000000006-SecurePersonalAccessTokens';
import { ApprovalPendingPaginationIndex1700000000007 } from '../migrations/1700000000007-ApprovalPendingPaginationIndex';
import { ExternalIdentityEmployeeId1700000000008 } from '../migrations/1700000000008-ExternalIdentityEmployeeId';
import { AnnouncementGroupScope1700000000009 } from '../migrations/1700000000009-AnnouncementGroupScope';
import { CustomRoleSupport1700000000010 } from '../migrations/1700000000010-CustomRoleSupport';
import { RemoveUnusedPermissions1700000000011 } from '../migrations/1700000000011-RemoveUnusedPermissions';
import { ApprovalInstanceResubmission1700000000012 } from '../migrations/1700000000012-ApprovalInstanceResubmission';
import { ApprovalFlowDefaultConstraint1700000000013 } from '../migrations/1700000000013-ApprovalFlowDefaultConstraint';
import { PermissionGrantConsistency1700000000014 } from '../migrations/1700000000014-PermissionGrantConsistency';
import { OrganizationSiblingConstraint1700000000015 } from '../migrations/1700000000015-OrganizationSiblingConstraint';
import { ExternalIdentityProviderConstraint1700000000016 } from '../migrations/1700000000016-ExternalIdentityProviderConstraint';

/**
 * PostgreSQL 是当前唯一生产数据库；保留旧分支仅用于历史代码读取，不再保证 SQLite 兼容。
 */
const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase() as 'sqlite' | 'postgres';

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
  ApprovalInstanceIdempotency1700000000005,
  SecurePersonalAccessTokens1700000000006,
  ApprovalPendingPaginationIndex1700000000007,
  ExternalIdentityEmployeeId1700000000008,
  AnnouncementGroupScope1700000000009,
  CustomRoleSupport1700000000010,
  RemoveUnusedPermissions1700000000011,
  ApprovalInstanceResubmission1700000000012,
  ApprovalFlowDefaultConstraint1700000000013,
  PermissionGrantConsistency1700000000014,
  OrganizationSiblingConstraint1700000000015,
  ExternalIdentityProviderConstraint1700000000016,
];

/**
 * 根据数据库类型构造 DataSourceOptions。
 * - sqlite: 单文件路径，WAL + foreign_keys pragma
 * - postgres: 标准网络连接参数
 */
function buildDataSourceOptions(): DataSourceOptions {
  const common = { entities, migrations, synchronize: shouldSynchronize, logging: false };

  if (dbType === 'postgres') {
    // 多实例总连接预算要小于 PostgreSQL max_connections；4 实例默认 4×12=48。
    const poolMax = parseInt(process.env.DB_POOL_MAX || '12', 10);
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
      extra: {
        max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 12,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 3_000,
      },
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
  // 固定 advisory lock id：仅用于本系统 schema/migration 启动阶段的跨实例互斥。
  const migrationLockId = 782_041_903;
  try {
    await queryRunner.connect();
    if (dbType === 'postgres') {
      await queryRunner.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
    }
    // 只看业务 schema：Postgres 的 getTables() 会带出 pg_catalog 等系统表，
    // 若用「任意非系统表」判断会导致永远跳过 synchronize。
    const SYSTEM_TABLES = new Set(['migrations', 'typeorm_metadata', 'sqlite_sequence']);
    let businessTableCount: number;
    if (dbType === 'postgres') {
      const rows = await queryRunner.query(`
        SELECT COUNT(*)::int AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name NOT IN ('migrations', 'typeorm_metadata')
          AND table_name NOT LIKE 'pg_%'
      `);
      businessTableCount = Number(rows?.[0]?.count ?? 0);
    } else {
      const tables = await queryRunner.getTables();
      businessTableCount = tables.filter((table) =>
        !SYSTEM_TABLES.has(table.name) && !table.name.startsWith('pg_')).length;
    }
    if (businessTableCount === 0) {
      await AppDataSource.synchronize(false);
    }
    // advisory lock 持有期间运行 migration，避免多个 API 同时启动时重复执行同一版本。
    await AppDataSource.runMigrations();
  } finally {
    if (dbType === 'postgres' && queryRunner.isReleased === false) {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [migrationLockId]).catch(() => undefined);
    }
    await queryRunner.release();
  }
}
