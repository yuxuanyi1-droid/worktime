import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 唯一约束补全：
 * 1. user_permission_grants 的 partial unique index（同一用户/权限码/作用域下仅一条 active）。
 * 2. weekly_reports 的 (userId, weekStart) 唯一索引（实体已有 @Unique，老库兜底）。
 * 3. users.email 唯一索引（实体已加 @Index unique，老库兜底；SQLite 多 NULL 不冲突）。
 * 4. user_roles / role_permissions 复合唯一索引（防重复关联，TypeORM JoinTable 默认无此约束）。
 *
 * 注意：这些索引对应实体的 @Unique/@Index，新库由 synchronize 创建；此 migration 是老库升级路径。
 */
export class UniqueConstraints1700000000005 implements MigrationInterface {
  name = 'UniqueConstraints1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. grant partial unique index
    try {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_grant_unique_active" ON "user_permission_grants" ("userId", "permissionCode", "scopeType", "scopeId") WHERE "status" = 'active'`
      );
    } catch {}
    // 2. weekly_reports (userId, weekStart)
    try {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "uq_weekly_report_user_week" ON "weekly_reports" ("userId", "weekStart")`
      );
    } catch {}
    // 3. users.email（SQLite 多 NULL 不冲突，空邮箱不受约束）
    try {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_unique" ON "users" ("email") WHERE "email" IS NOT NULL`
      );
    } catch {}
    // 4. user_roles 复合唯一
    try {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_roles_unique" ON "user_roles" ("userId", "roleId")`
      );
    } catch {}
    // 5. role_permissions 复合唯一
    try {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_role_permissions_unique" ON "role_permissions" ("roleId", "permissionId")`
      );
    } catch {}
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try { await queryRunner.query(`DROP INDEX IF EXISTS "idx_grant_unique_active"`); } catch {}
    try { await queryRunner.query(`DROP INDEX IF EXISTS "idx_role_permissions_unique"`); } catch {}
    try { await queryRunner.query(`DROP INDEX IF EXISTS "idx_user_roles_unique"`); } catch {}
    // 不删除 weekly_reports / users.email 唯一索引：对应实体 @Unique/@Index，删除破坏新库一致性
  }
}
