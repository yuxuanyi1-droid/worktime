import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsRoot, '..');
const vitestEntry = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const configPath = 'tests/config/vitest.client.config.ts';

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(absolute);
    return /\.(test|spec)\.(ts|tsx)$/.test(entry.name)
      ? [relative(repoRoot, absolute).replaceAll('\\', '/')]
      : [];
  });
}

function run(files, coverageDirectory) {
  const coverageArgs = coverageDirectory ? [
    '--coverage',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${coverageDirectory}`,
  ] : [];
  const result = spawnSync(process.execPath, [
    vitestEntry,
    'run',
    '--config',
    configPath,
    '--maxWorkers=1',
    ...coverageArgs,
    ...files,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const coverageMode = args[0] === '--coverage-batched';
const requested = coverageMode ? args.slice(1) : args;
if (requested.length) {
  run(requested, coverageMode ? 'tests/coverage/client' : undefined);
} else {
  // Ant Design 页面测试的模块体积较大。分批启动隔离进程，避免 WSL/CI 在单进程
  // 连续加载全部页面后出现峰值内存过高而被系统直接终止。
  const files = collectTests(resolve(testsRoot, 'client')).sort();
  const batchSize = 6;
  const coverageRoot = resolve(testsRoot, 'coverage/client');
  const rawCoverageRoot = join(coverageRoot, 'raw');
  if (coverageMode) {
    rmSync(coverageRoot, { recursive: true, force: true });
    mkdirSync(rawCoverageRoot, { recursive: true });
  }
  for (let index = 0; index < files.length; index += batchSize) {
    const coverageDirectory = coverageMode
      ? relative(repoRoot, join(rawCoverageRoot, `batch-${index / batchSize + 1}`)).replaceAll('\\', '/')
      : undefined;
    run(files.slice(index, index + batchSize), coverageDirectory);
  }

  if (coverageMode) {
    const require = createRequire(import.meta.url);
    const { createCoverageMap } = require('istanbul-lib-coverage');
    const { createContext } = require('istanbul-lib-report');
    const reports = require('istanbul-reports');
    const merged = createCoverageMap({});
    for (const batch of readdirSync(rawCoverageRoot)) {
      const reportPath = join(rawCoverageRoot, batch, 'coverage-final.json');
      merged.merge(JSON.parse(readFileSync(reportPath, 'utf8')));
    }
    writeFileSync(join(coverageRoot, 'coverage-final.json'), JSON.stringify(merged.toJSON()));
    const context = createContext({ dir: coverageRoot, coverageMap: merged });
    reports.create('text').execute(context);
    reports.create('html').execute(context);
    reports.create('json-summary').execute(context);
  }
}
