import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始 schema 版本标记 migration。
 *
 * 说明：
 * 真正的建表由 ensureSchema() 中的 synchronize(false) 完成（空库时根据实体元数据建表）。
 * 此 migration 仅作为版本基线占位——未来若新增字段/表，应新增增量 migration，
 * 在 up() 内用 IF NOT EXISTS 幂等语句补齐（先查后建）。
 *
 * up/down 均为空操作，避免与 synchronize 的建表产生重复列冲突。
 */
export class InitSchema1700000000000 implements MigrationInterface {
  name = 'InitSchema1700000000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // 无操作：建表由 ensureSchema 的 synchronize 负责
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 无操作
  }
}
