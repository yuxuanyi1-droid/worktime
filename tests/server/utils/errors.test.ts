import { describe, it, expect } from 'vitest';
import { BusinessError, isBusinessError } from '@server/utils/errors';

describe('BusinessError', () => {
  it('默认 statusCode 为 400', () => {
    const err = new BusinessError('参数错误');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(400);
    expect(err.message).toBe('参数错误');
    expect(err.name).toBe('BusinessError');
    expect(err instanceof Error).toBe(true);
  });

  it('支持自定义 statusCode 与 code', () => {
    const err = new BusinessError('无权限', 403);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(403);
  });

  it('isBusinessError 正确识别 BusinessError', () => {
    expect(isBusinessError(new BusinessError('x'))).toBe(true);
    expect(isBusinessError(new Error('x'))).toBe(false);
    expect(isBusinessError(null)).toBe(false);
    expect(isBusinessError(undefined)).toBe(false);
    expect(isBusinessError('字符串')).toBe(false);
  });
});
