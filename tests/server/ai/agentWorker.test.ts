import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSessionQuota,
  buildQueryUrl,
  buildShanghaiCalendarContext,
  createModelRuntime,
  entryMessageText,
  messageText,
  serializeHistory,
} from '@server/ai/agentWorker';

describe('AI Worker 纯逻辑', () => {
  it('限制每名用户保留的历史会话数量', () => {
    expect(() => assertSessionQuota(29, 30)).not.toThrow();
    expect(() => assertSessionQuota(30, 30)).toThrow('最多保留30条对话');
    expect(() => assertSessionQuota(-1, 30)).toThrow('会话数量无效');
  });
  it('只把白名单查询参数拼入固定资源地址', () => {
    const url = new URL(buildQueryUrl('http://127.0.0.1:3000/api/v1', 'personal_report', {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      weekEnd: '2026-07-26',
      userId: 7,
      includeAll: false,
      ignored: 'secret',
      status: '',
    }));

    expect(url.pathname).toBe('/api/v1/reports/personal');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      weekEnd: '2026-07-26',
      userId: '7',
      includeAll: 'false',
    });
    expect(url.searchParams.has('ignored')).toBe(false);
  });

  it('按 Asia/Shanghai 计算当前日期及周一到周日范围', () => {
    expect(buildShanghaiCalendarContext(new Date('2026-07-19T16:30:00.000Z'))).toEqual({
      today: '2026-07-20',
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
    });
  });

  it('兼容字符串和分段消息，并忽略非文本片段', () => {
    expect(messageText({ content: '直接文本' })).toBe('直接文本');
    expect(messageText({ content: [
      { type: 'text', text: '第一段' },
      { type: 'thinking', thinking: '内部思考' },
      { type: 'text', text: '第二段' },
    ] })).toBe('第一段第二段');
    expect(messageText(null)).toBe('');
    expect(messageText({ content: { text: 'invalid' } })).toBe('');
  });

  it('历史序列化仅保留有正文的用户和助手消息', () => {
    expect(serializeHistory({ messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '  查询工时  ' },
      { role: 'assistant', content: [{ type: 'text', text: '共 5 天' }] },
      { role: 'assistant', content: '   ' },
    ] })).toEqual([
      {
        id: 'history_1', role: 'user',
        parts: [{ id: 'history_1_text', type: 'text', text: '查询工时', done: true }],
      },
      {
        id: 'history_2', role: 'assistant',
        parts: [{ id: 'history_2_text', type: 'text', text: '共 5 天', done: true }],
      },
    ]);
  });

  it('重新生成只识别用户消息条目', () => {
    expect(entryMessageText({ type: 'message', message: { role: 'user', content: ' 再试一次 ' } }))
      .toBe('再试一次');
    expect(entryMessageText({ type: 'message', message: { role: 'assistant', content: '回答' } })).toBe('');
    expect(entryMessageText({ type: 'tool', message: { role: 'user', content: '参数' } })).toBe('');
  });

  it('使用当前 pi SDK 的 ModelRuntime 加载自定义模型并注入运行时密钥', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worktime-pi-sdk-'));
    const modelsPath = path.join(directory, 'models.json');
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        'worktime-contract': {
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          models: [{
            id: 'contract-model',
            name: 'contract-model',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          }],
        },
      },
    }));

    try {
      const sdk = await import('@earendil-works/pi-coding-agent');

      expect(sdk.AuthStorage).toBeUndefined();
      const { modelRuntime, model } = await createModelRuntime(sdk, modelsPath, {
        piProviderName: 'worktime-contract',
        apiKey: 'runtime-only-key',
        modelId: 'contract-model',
      }, path.join(directory, 'auth.json'));

      expect(model).toMatchObject({ provider: 'worktime-contract', id: 'contract-model' });
      expect(modelRuntime.hasConfiguredAuth('worktime-contract')).toBe(true);
      const authPath = path.join(directory, 'auth.json');
      const persistedAuth = fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : '';
      expect(persistedAuth).not.toContain('runtime-only-key');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
