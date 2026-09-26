import { DataSource } from 'typeorm';
import { AppDataSource } from '../config/database';
import { SubmissionSequence } from '../entities/SubmissionSequence';

/**
 * 测试专用 setupTestDb：初始化/重置 AppDataSource（统一内存库）
 */
export async function setupTestDb(): Promise<DataSource> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  // 清空各表并使用 synchronize 保证一致性
  await AppDataSource.synchronize(true);
  // 初始化序列表单行
  await AppDataSource.getRepository(SubmissionSequence).save({ id: 1, currentValue: 0 });
  return AppDataSource;
}

export function getTestDataSource(): DataSource {
  if (!AppDataSource.isInitialized) throw new Error('测试 DB 未初始化，请先调用 setupTestDb()');
  return AppDataSource;
}

export async function teardownTestDb(): Promise<void> {
  // 保持连接供后续测试模块复用
}
