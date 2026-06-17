import { describe, it, expect } from 'vitest';
import {
  parsePositiveInt,
  parseOptionalPositiveInt,
  parseDateString,
  parseEnum,
  parseBooleanQuery,
  parseString,
  parseHours,
  parseArray,
  parsePagination,
  firstQueryValue,
} from './validation';
import { BusinessError } from './errors';

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
});

describe('parseHours', () => {
  it('合法工时', () => {
    expect(parseHours(8)).toBe(8);
    expect(parseHours('0.5')).toBe(0.5);
  });

  it('0 或负数抛错', () => {
    expect(() => parseHours(0)).toThrow();
    expect(() => parseHours(-1)).toThrow();
  });

  it('超过 24 抛错', () => {
    expect(() => parseHours(25)).toThrow();
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
