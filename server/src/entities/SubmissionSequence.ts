import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * 提交分组 ID 序列计数器（单行表，id 恒为 1）。
 * 用于替代 `SELECT MAX(submissionGroupId) + 1` 的并发不安全写法。
 * 在事务内通过原子自增保证唯一性。
 */
@Entity('submission_sequences')
export class SubmissionSequence {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column({ type: 'integer', default: 0 })
  currentValue!: number;
}
