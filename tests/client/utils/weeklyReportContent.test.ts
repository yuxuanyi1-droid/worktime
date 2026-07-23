import { describe, expect, it } from 'vitest';
import { weeklyReportContentToText } from '@client/utils/weeklyReportContent';

describe('weeklyReportContentToText', () => {
  it('保持新版本纯文本原样，包括普通比较符号', () => {
    expect(weeklyReportContentToText('完成率 a < b > c\n第二行')).toBe('完成率 a < b > c\n第二行');
  });

  it('把旧版富文本内容无损降级为易读纯文本', () => {
    expect(weeklyReportContentToText(
      '<strong>项目：</strong> 工时系统<br><strong>工作内容：</strong><br />完成审批模块',
    )).toBe('项目： 工时系统\n工作内容：\n完成审批模块');
  });

  it('移除可执行标签且不会因异常字符实体而崩溃', () => {
    const result = weeklyReportContentToText('<img src=x onerror=alert(1)>安全内容<script>alert(2)</script>&#999999999;');
    expect(result).toBe('安全内容alert(2)&#999999999;');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('<img');
  });
});
