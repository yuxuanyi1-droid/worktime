import { defineConfig } from 'vitest/config';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      '@server': path.join(repoRoot, 'server/src'),
      typeorm: path.join(repoRoot, 'node_modules/typeorm'),
      // typeorm 别名指向 root，但 better-sqlite3 仅在 server/node_modules；显式别名避免 SQLite 驱动解析失败
      'better-sqlite3': path.join(repoRoot, 'server/node_modules/better-sqlite3'),
      bcryptjs: path.join(repoRoot, 'server/node_modules/bcryptjs'),
      jsonwebtoken: path.join(repoRoot, 'server/node_modules/jsonwebtoken'),
      exceljs: path.join(repoRoot, 'server/node_modules/exceljs'),
      express: path.join(repoRoot, 'server/node_modules/express'),
      'openid-client': path.join(repoRoot, 'server/node_modules/openid-client/build/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/server/**/*.test.ts'],
    isolate: true,
    testTimeout: 15000,
    setupFiles: ['tests/server/setup.ts'],
    env: {
      SUBMIT_APPROVAL_SYNC: '1',
      WORKTIME_DISABLE_AUTO_START: '1',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'tests/coverage/server',
      reporter: ['text', 'html', 'json', 'json-summary'],
      include: ['server/src/**/*.ts'],
      exclude: [
        'server/src/**/*.d.ts',
        'server/src/migrations/**',
        'server/src/seed.ts',
      ],
    },
  },
});
