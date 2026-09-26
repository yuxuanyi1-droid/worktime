import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'test_secret_for_vitest_key_32chars_long_123456';
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { setupTestDb, teardownTestDb, getTestDataSource } from '../test/setup';
import { User } from '../entities/User';
import { Role } from '../entities/Role';
import { Permission } from '../entities/Permission';
import { PersonalAccessToken } from '../entities/PersonalAccessToken';
import { hashPat } from '../middleware/auth';

describe('App & Security Middleware Integration Tests', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('GET /api/health should return ok status and database status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('should set Helmet security headers on response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should enforce PAT scope restrictions in middleware', async () => {
    const ds = getTestDataSource();

    // 创建测试权限与角色
    const permRead = await ds.getRepository(Permission).save({
      code: 'timesheet:read',
      name: '查看工时',
      module: 'timesheet',
      action: 'read',
    });
    const permCreate = await ds.getRepository(Permission).save({
      code: 'timesheet:create',
      name: '创建工时',
      module: 'timesheet',
      action: 'create',
    });

    const adminRole = await ds.getRepository(Role).save({
      name: 'admin',
      label: '管理员',
      permissions: [permRead, permCreate],
    });

    const user = await ds.getRepository(User).save({
      username: 'patadmin',
      password: 'hash',
      realName: 'PAT Admin',
      status: 1,
      tokenVersion: 1,
      roles: [adminRole],
    });

    const plainToken = 'wpat_testtoken12345678901234567890';
    // 创建限权 PAT，仅授权 timesheet:read 权限
    await ds.getRepository(PersonalAccessToken).save({
      userId: user.id,
      name: 'Read Only PAT',
      tokenHash: hashPat(plainToken),
      tokenPlain: plainToken,
      prefix: 'wpat_testtok',
      scopes: 'timesheet:read',
    });

    // 请求 /my 端点，仅需要登录或读权限，PAT scope 满足 timesheet:read，放行（返回 200）
    const readRes = await request(app)
      .get('/api/v1/timesheets/my')
      .set('Authorization', `Bearer ${plainToken}`);
    expect(readRes.status).toBe(200);

    // 请求 POST /timesheets 端点（需要 timesheet:create 权限），PAT scope 中无此权限，拦截（返回 403）
    const createRes = await request(app)
      .post('/api/v1/timesheets')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ projectId: 1, date: '2025-01-01', days: 1, description: 'Test' });
    expect(createRes.status).toBe(403);
    expect(createRes.body.message).toBe('无此操作权限');
  });
});
