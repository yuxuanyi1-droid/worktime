import { describe, it, expect } from 'vitest';
import {
  assertDateRange,
  parsePositiveInt,
  parseOptionalPositiveInt,
  parseDateString,
  parseEnum,
  parseBooleanQuery,
  parseOptionalBooleanQuery,
  parseOptionalDateTime,
  parseString,
  parseOptionalEmail,
  parseOptionalPhone,
  parseDays,
  parseArray,
  parsePagination,
  firstQueryValue,
} from '@server/utils/validation';
import { BusinessError } from '@server/utils/errors';

describe('parsePositiveInt', () => {
  it('正常解析正整数', () => {
    expect(parsePositiveInt(5, 'id')).toBe(5);
    expect(parsePositiveInt('10', 'id')).toBe(10);
  });

  it('空值时返回 defaultValue', () => {
    expect(parsePositiveInt(undefined, 'id', { defaultValue: 1 })).toBe(1);
    expect(parsePositiveInt('', 'id', { defaultValue: 1 })).toBe(1);
  });

  it('空值且无 defaultValue 抛 BusinessError(400)', () => {
    expect(() => parsePositiveInt(undefined, 'id')).toThrow(BusinessError);
    try {
      parsePositiveInt(undefined, 'id');
    } catch (e) {
      expect((e as BusinessError).statusCode).toBe(400);
    }
  });

  it('非正整数抛错', () => {
    expect(() => parsePositiveInt(0, 'id')).toThrow();
    expect(() => parsePositiveInt(-1, 'id')).toThrow();
    expect(() => parsePositiveInt(1.5, 'id')).toThrow();
    expect(() => parsePositiveInt('abc', 'id')).toThrow();
  });

  it('超过 max 抛错', () => {
    expect(() => parsePositiveInt(200, 'pageSize', { max: 100 })).toThrow();
  });
});

describe('parseOptionalPositiveInt', () => {
  it('空值返回 undefined', () => {
    expect(parseOptionalPositiveInt(undefined, 'id')).toBeUndefined();
    expect(parseOptionalPositiveInt('', 'id')).toBeUndefined();
  });

  it('有值时解析', () => {
    expect(parseOptionalPositiveInt('5', 'id')).toBe(5);
  });
});

describe('parseDateString', () => {
  it('合法日期', () => {
    expect(parseDateString('2024-01-15', 'date')).toBe('2024-01-15');
  });

  it('非法格式抛错', () => {
    expect(() => parseDateString('2024/01/15', 'date')).toThrow();
    expect(() => parseDateString('20240115', 'date')).toThrow();
    expect(() => parseDateString('not-a-date', 'date')).toThrow();
  });

  it('不存在日期抛错（如 2 月 30 日）', () => {
    expect(() => parseDateString('2024-02-30', 'date')).toThrow();
  });
});

describe('parseEnum', () => {
  const allowed = ['a', 'b', 'c'] as const;
  it('合法值', () => {
    expect(parseEnum('a', 'type', allowed)).toBe('a');
  });

  it('非法值抛错', () => {
    expect(() => parseEnum('d', 'type', allowed)).toThrow();
    expect(() => parseEnum(123, 'type', allowed)).toThrow();
  });
});

describe('parseBooleanQuery', () => {
  it('仅 true 与 "true" 为真', () => {
    expect(parseBooleanQuery(true)).toBe(true);
    expect(parseBooleanQuery('true')).toBe(true);
    expect(parseBooleanQuery(false)).toBe(false);
    expect(parseBooleanQuery('false')).toBe(false);
    expect(parseBooleanQuery(undefined)).toBe(false);
    expect(parseBooleanQuery(1)).toBe(false);
  });
});

describe('parseOptionalBooleanQuery', () => {
  it('解析显式布尔查询值', () => {
    expect(parseOptionalBooleanQuery('true', 'isRead')).toBe(true);
    expect(parseOptionalBooleanQuery('false', 'isRead')).toBe(false);
    expect(parseOptionalBooleanQuery(undefined, 'isRead')).toBeUndefined();
  });

  it('拒绝模糊或拼写错误的布尔值', () => {
    expect(() => parseOptionalBooleanQuery('yes', 'isRead')).toThrow('isRead必须是true或false');
    expect(() => parseOptionalBooleanQuery(1, 'isRead')).toThrow('isRead必须是true或false');
  });
});

describe('parseOptionalDateTime', () => {
  it('接受 ISO 时间和日期并规范化', () => {
    expect(parseOptionalDateTime('2026-07-21T08:30:00+08:00', 'startDate'))
      .toBe('2026-07-21T00:30:00.000Z');
    expect(parseOptionalDateTime('2026-07-21', 'startDate'))
      .toBe('2026-07-21T00:00:00.000Z');
  });

  it('拒绝无效日期时间', () => {
    expect(() => parseOptionalDateTime('not-a-date', 'startDate')).toThrow('startDate必须是有效日期时间');
  });
});

describe('parseString', () => {
  it('非必填空值返回 undefined', () => {
    expect(parseString(undefined, 'name')).toBeUndefined();
  });

  it('必填空值抛错', () => {
    expect(() => parseString(undefined, 'name', { required: true })).toThrow();
    expect(() => parseString('   ', 'name', { required: true })).toThrow();
  });

  it('trim 并校验 max', () => {
    expect(parseString('  hello  ', 'name')).toBe('hello');
    expect(() => parseString('toolong', 'name', { max: 3 })).toThrow();
  });

  it('校验 min', () => {
    expect(parseString('12345678', 'password', { min: 8 })).toBe('12345678');
    expect(() => parseString('1234567', 'password', { min: 8 })).toThrow();
  });

  it('可为密码保留首尾空格', () => {
    expect(parseString('  pass word  ', 'password', { trim: false })).toBe('  pass word  ');
  });
});

describe('联系方式校验', () => {
  it('允许合法邮箱、手机号和空字符串清空字段', () => {
    expect(parseOptionalEmail(' user@example.com ')).toBe('user@example.com');
    expect(parseOptionalPhone('+86 138-0013-8000')).toBe('+86 138-0013-8000');
    expect(parseOptionalEmail('')).toBe('');
    expect(parseOptionalPhone('')).toBe('');
  });

  it('拒绝明显无效的联系方式', () => {
    expect(() => parseOptionalEmail('not-an-email')).toThrow('邮箱格式无效');
    expect(() => parseOptionalPhone('abc123')).toThrow('手机号格式无效');
  });
});

describe('parseDays', () => {
  it('合法工时（天）', () => {
    expect(parseDays(1)).toBe(1);
    expect(parseDays('0.5')).toBe(0.5);
  });

  it('0 或负数抛错', () => {
    expect(() => parseDays(0)).toThrow();
    expect(() => parseDays(-1)).toThrow();
  });

  it('超过 1 天抛错', () => {
    expect(() => parseDays(1.5)).toThrow();
  });
});

describe('parseArray', () => {
  it('正常数组', () => {
    expect(parseArray([1, 2], 'ids', (x) => Number(x))).toEqual([1, 2]);
  });

  it('非数组抛错', () => {
    expect(() => parseArray('notarray', 'ids', (x) => x)).toThrow();
  });

  it('min/max 约束', () => {
    expect(() => parseArray([], 'ids', (x) => x, { min: 1 })).toThrow();
    expect(() => parseArray([1, 2, 3], 'ids', (x) => x, { max: 2 })).toThrow();
  });
});

describe('parsePagination', () => {
  it('默认值', () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('自定义默认 pageSize', () => {
    expect(parsePagination({}, 50)).toEqual({ page: 1, pageSize: 50 });
  });

  it('解析传入值', () => {
    expect(parsePagination({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10 });
  });
});

describe('firstQueryValue', () => {
  it('字符串直接返回', () => {
    expect(firstQueryValue('a')).toBe('a');
  });

  it('数组取首项', () => {
    expect(firstQueryValue(['a', 'b'])).toBe('a');
  });

  it('undefined 透传', () => {
    expect(firstQueryValue(undefined)).toBeUndefined();
  });
});

describe('assertDateRange', () => {
  it('允许同日、正向区间和单边日期', () => {
    expect(() => assertDateRange('2026-07-01', '2026-07-01')).not.toThrow();
    expect(() => assertDateRange('2026-07-01', '2026-07-31')).not.toThrow();
    expect(() => assertDateRange('2026-07-01', undefined)).not.toThrow();
  });

  it('拒绝开始日期晚于结束日期', () => {
    expect(() => assertDateRange('2026-07-31', '2026-07-01'))
      .toThrow('startDate不能晚于endDate');
  });
});
