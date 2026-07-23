import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

function fileStems(directory: string, pattern: RegExp): string[] {
  return fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name.replace(pattern, '$1'))
    .sort();
}

function pageNames(): string[] {
  return fs.readdirSync(path.join(repoRoot, 'client/src/pages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, 'client/src/pages', entry.name, 'index.tsx')))
    .map((entry) => entry.name)
    .sort();
}

function findTestsOutsideRoot(directory: string): string[] {
  const result: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        result.push(path.relative(repoRoot, absolute));
      }
    }
  };
  visit(path.join(repoRoot, directory));
  return result.sort();
}

describe('测试目录与功能清单守卫', () => {
  it('每个后端路由域都有根 tests/server/routes 下的契约测试', () => {
    const routes = fileStems('server/src/routes', /^(.*)\.ts$/);
    const routeTests = new Set(fileStems('tests/server/routes', /^(.*)\.test\.ts$/));
    expect(routes.filter((route) => !routeTests.has(route))).toEqual([]);
  });

  it('每个前端页面都有根 tests/client/pages 下的交互测试', () => {
    const testedPages = new Set(fileStems('tests/client/pages', /^(.*)\.test\.tsx$/));
    expect(pageNames().filter((page) => !testedPages.has(page))).toEqual([]);
  });

  it('server 和 client 源码目录不再散落测试文件', () => {
    expect([
      ...findTestsOutsideRoot('server'),
      ...findTestsOutsideRoot('client'),
    ]).toEqual([]);
  });
});
