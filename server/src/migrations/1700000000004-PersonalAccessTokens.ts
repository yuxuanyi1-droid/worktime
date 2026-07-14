import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 个人访问令牌表。
 *
 * 用于 pi agent skill / 外部工具通过 PAT 调本系统 HTTP API。
 * 开发期 ensureSchema 的 synchronize 会在空库时根据实体建表；
 * 此 migration 作为版本记录 + 老库升级路径。
 *
 * 字段说明见 entities/PersonalAccessToken.ts。
 */
export class PersonalAccessTokens1700000000004 implements MigrationInterface {
  name = 'PersonalAccessTokens1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "personal_access_tokens" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "userId" integer NOT NULL,
        "name" varchar(100) NOT NULL,
        "tokenHash" varchar(255) NOT NULL,
        "tokenPlain" text NOT NULL,
        "prefix" varchar(20) NOT NULL,
        "scopes" varchar(500),
        "lastUsedAt" datetime,
        "expiresAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "fk_pat_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_pat_user_created" ON "personal_access_tokens" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_pat_token_hash" ON "personal_access_tokens" ("tokenHash")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_pat_token_hash"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_pat_user_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "personal_access_tokens"`);
  }
}
