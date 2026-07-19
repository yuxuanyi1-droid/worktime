import { MigrationInterface, QueryRunner } from 'typeorm';

/** 清除历史 PAT 明文，并允许新令牌只保存 hash。 */
export class SecurePersonalAccessTokens1700000000006 implements MigrationInterface {
  name = 'SecurePersonalAccessTokens1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.driver.options.type === 'postgres';
    if (isPg) {
      await queryRunner.query(`ALTER TABLE "personal_access_tokens" ALTER COLUMN "tokenPlain" DROP NOT NULL`);
      await queryRunner.query(`UPDATE "personal_access_tokens" SET "tokenPlain" = NULL`);
      return;
    }

    await queryRunner.query(`
      CREATE TABLE "personal_access_tokens_secure" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "userId" integer NOT NULL,
        "name" varchar(100) NOT NULL,
        "tokenHash" varchar(255) NOT NULL,
        "tokenPlain" text,
        "prefix" varchar(20) NOT NULL,
        "scopes" varchar(500),
        "lastUsedAt" datetime,
        "expiresAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "fk_pat_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      INSERT INTO "personal_access_tokens_secure"
        ("id", "userId", "name", "tokenHash", "tokenPlain", "prefix", "scopes", "lastUsedAt", "expiresAt", "createdAt", "updatedAt")
      SELECT "id", "userId", "name", "tokenHash", NULL, "prefix", "scopes", "lastUsedAt", "expiresAt", "createdAt", "updatedAt"
      FROM "personal_access_tokens"
    `);
    await queryRunner.query(`DROP TABLE "personal_access_tokens"`);
    await queryRunner.query(`ALTER TABLE "personal_access_tokens_secure" RENAME TO "personal_access_tokens"`);
    await this.createIndexes(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.driver.options.type === 'postgres';
    if (isPg) {
      await queryRunner.query(`UPDATE "personal_access_tokens" SET "tokenPlain" = '' WHERE "tokenPlain" IS NULL`);
      await queryRunner.query(`ALTER TABLE "personal_access_tokens" ALTER COLUMN "tokenPlain" SET NOT NULL`);
      return;
    }

    await queryRunner.query(`
      CREATE TABLE "personal_access_tokens_legacy" (
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
    await queryRunner.query(`
      INSERT INTO "personal_access_tokens_legacy"
        ("id", "userId", "name", "tokenHash", "tokenPlain", "prefix", "scopes", "lastUsedAt", "expiresAt", "createdAt", "updatedAt")
      SELECT "id", "userId", "name", "tokenHash", COALESCE("tokenPlain", ''), "prefix", "scopes", "lastUsedAt", "expiresAt", "createdAt", "updatedAt"
      FROM "personal_access_tokens"
    `);
    await queryRunner.query(`DROP TABLE "personal_access_tokens"`);
    await queryRunner.query(`ALTER TABLE "personal_access_tokens_legacy" RENAME TO "personal_access_tokens"`);
    await this.createIndexes(queryRunner);
  }

  private async createIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_pat_user_created" ON "personal_access_tokens" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_pat_token_hash" ON "personal_access_tokens" ("tokenHash")`);
  }
}
