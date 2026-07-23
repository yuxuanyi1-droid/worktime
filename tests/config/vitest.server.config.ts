import { defineConfig } from 'vitest/config';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      '@server': path.join(repoRoot, 'server/src'),
      typeorm: path.join(repoRoot, 'node_modules/typeorm'),
      bcryptjs: path.join(repoRoot, 'server/node_modules/bcryptjs'),
      jsonwebtoken: path.join(repoRoot, 'server/node_modules/jsonwebtoken'),
      express: path.join(repoRoot, 'server/node_modules/express'),
      'openid-client': path.join(repoRoot, 'server/node_modules/openid-client/build/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/server/**/*.test.ts'],
    isolate: true,
    testTimeout: 15000,
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
