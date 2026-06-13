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

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/worktime.db');
const shouldSynchronize = process.env.NODE_ENV !== 'production' && process.env.TYPEORM_SYNCHRONIZE !== 'false';

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: dbPath,
  synchronize: shouldSynchronize,
  logging: false,
  entities: [
    User, Department, Group, Role, Permission, Project,
    Timesheet, OvertimeApplication, WeeklyReport,
    ApprovalRecord, ProjectSE, ApprovalFlow, ApprovalFlowStep,
    ApprovalFlowVersion, ApprovalInstance, ApprovalTask,
    SystemSetting, Notification, AuditLog, Announcement, AnnouncementRead,
    PermissionRequest, UserPermissionGrant,
  ],
  migrations: [],
  subscribers: [],
  prepareDatabase: (db: any) => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  },
});
