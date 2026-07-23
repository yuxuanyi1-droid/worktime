import { describe, expect, it, vi } from 'vitest';
import { requireJwtSession } from '@server/routes/pat';

describe('PAT 管理入口认证边界', () => {
  it('只允许 JWT 登录会话管理令牌，拒绝 PAT 自我管理', () => {
    const jwtNext = vi.fn();
    requireJwtSession({ authMethod: 'jwt' } as any, {}, jwtNext);
    expect(jwtNext).toHaveBeenCalledWith();

    const patNext = vi.fn();
    requireJwtSession({ authMethod: 'pat' } as any, {}, patNext);
    expect(patNext).toHaveBeenCalledTimes(1);
    expect(patNext.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: 403 });
  });
});
