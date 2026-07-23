import { describe, expect, it } from 'vitest';
import { normalizeProviderUserInfo } from '@server/services/oidc/provider';

describe('第三方身份 claim 标准化', () => {
  it('清理身份字段空白，同时保留明确的空部门用于清除组织归属', () => {
    expect(normalizeProviderUserInfo({
      subject: ' subject ', username: ' user ', displayName: ' 姓名 ', department: '   ',
      groups: [' dev ', '', 12 as any],
    })).toMatchObject({
      subject: 'subject', username: 'user', displayName: '姓名', department: '', groups: ['dev'],
    });
  });

  it('拒绝空身份、过长字段和过深部门路径', () => {
    expect(() => normalizeProviderUserInfo({ subject: '   ' })).toThrow('缺少唯一标识');
    expect(() => normalizeProviderUserInfo({ subject: 'ok', displayName: 'x'.repeat(51) }))
      .toThrow('姓名超过50个字符');
    expect(() => normalizeProviderUserInfo({
      subject: 'ok', department: Array.from({ length: 21 }, (_, index) => `g${index}`).join('/'),
    })).toThrow('部门层级过深');
  });
});
