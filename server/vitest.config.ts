import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试环境：Node
    environment: 'node',
    // 测试文件位置
    include: ['src/**/*.test.ts'],
    // 每个测试文件独立隔离（避免共享 DB 状态）
    isolate: true,
    // 默认超时（DB 初始化可能较慢）
    testTimeout: 15000,
  },
});
