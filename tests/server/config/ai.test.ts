import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('fs', () => ({ default: fsMock, ...fsMock }));
vi.mock('@server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  fsMock.existsSync.mockReset().mockReturnValue(false);
  fsMock.mkdirSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.chmodSync.mockReset();
  vi.resetModules();
});

async function loadAi(env: Record<string, string | undefined>) {
  for (const key of ['AI_PROVIDER', 'AI_API_KEY', 'AI_BASE_URL', 'AI_API_TYPE', 'AI_MODEL', 'AI_MODEL_NAME', 'AI_CONTEXT_WINDOW', 'AI_MAX_TOKENS']) {
    // dotenv 不覆盖已存在变量；空字符串可明确屏蔽开发机 .env 中的真实 AI 配置。
    process.env[key] = '';
  }
  Object.entries(env).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  return import('@server/config/ai');
}

describe('AI 配置', () => {
  it('缺少 API Key 时保持主系统可用但关闭 AI', async () => {
    const ai = await loadAi({ AI_PROVIDER: 'custom', AI_BASE_URL: 'https://llm.example/v1', AI_MODEL: 'model' });
    expect(ai.aiReady).toBe(false);
    expect(ai.aiConfig.ready).toBe(false);
  });

  it('自定义 OpenAI 兼容服务生成供 pi 使用的最小模型配置', async () => {
    const ai = await loadAi({
      AI_PROVIDER: 'custom',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://llm.example/v1',
      AI_API_TYPE: 'openai-completions',
      AI_MODEL: 'qwen-test',
      AI_MODEL_NAME: '测试模型',
    });
    expect(ai.aiReady).toBe(true);
    expect(ai.isAiRuntimeReady()).toBe(false);
    expect(ai.aiConfig).toMatchObject({
      provider: 'custom',
      baseUrl: 'https://llm.example/v1',
      apiType: 'openai-completions',
      modelId: 'qwen-test',
      piProviderName: 'worktime-llm',
    });

    expect(ai.ensurePiModelsJson()).toBe(true);
    expect(ai.isAiRuntimeReady()).toBe(true);
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/server/data'), { recursive: true, mode: 0o700 });
    const content = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(content.providers['worktime-llm']).toMatchObject({
      baseUrl: 'https://llm.example/v1',
      api: 'openai-completions',
    });
    expect(content.providers['worktime-llm'].models[0]).toMatchObject({ id: 'qwen-test', name: '测试模型' });
    expect(fsMock.writeFileSync.mock.calls[0][2]).toEqual({ encoding: 'utf8', mode: 0o600 });
    expect(fsMock.chmodSync).toHaveBeenCalledWith(expect.stringContaining('pi-models.json'), 0o600);
  });

  it('models.json 写入失败时运行态保持关闭，不能展示必然失败的入口', async () => {
    const ai = await loadAi({
      AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_MODEL: 'model', AI_BASE_URL: 'https://llm.example/v1',
    });
    fsMock.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(ai.aiReady).toBe(true);
    expect(ai.ensurePiModelsJson()).toBe(false);
    expect(ai.isAiRuntimeReady()).toBe(false);
  });

  it('custom 缺少地址或模型时拒绝启用', async () => {
    expect((await loadAi({ AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_MODEL: 'model' })).aiReady).toBe(false);
    vi.resetModules();
    expect((await loadAi({ AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_BASE_URL: 'https://llm.example/v1' })).aiReady).toBe(false);
  });

  it('官方提供商在未指定模型时使用明确默认值', async () => {
    const anthropic = await loadAi({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'key' });
    expect(anthropic.aiConfig).toMatchObject({
      provider: 'anthropic',
      apiType: 'anthropic-messages',
      modelId: 'claude-sonnet-4-20250514',
    });
  });

  it('拒绝未知提供商、协议以及带凭证或非 HTTP 的服务地址', async () => {
    expect((await loadAi({ AI_PROVIDER: 'unknown', AI_API_KEY: 'key', AI_MODEL: 'model' })).aiReady).toBe(false);
    vi.resetModules();
    expect((await loadAi({
      AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_MODEL: 'model',
      AI_BASE_URL: 'https://llm.example/v1', AI_API_TYPE: 'invalid',
    })).aiReady).toBe(false);
    vi.resetModules();
    expect((await loadAi({
      AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_MODEL: 'model',
      AI_BASE_URL: 'https://user:secret@llm.example/v1',
    })).aiReady).toBe(false);
    vi.resetModules();
    expect((await loadAi({
      AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_MODEL: 'model', AI_BASE_URL: 'file:///tmp/model',
    })).aiReady).toBe(false);
  });

  it('数值配置仅接受合理整数，且最大输出不超过上下文窗口', async () => {
    const ai = await loadAi({
      AI_PROVIDER: 'custom', AI_API_KEY: 'key', AI_MODEL: 'model',
      AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_CONTEXT_WINDOW: '4096', AI_MAX_TOKENS: '8192',
    });
    expect(ai.aiConfig.contextWindow).toBe(4096);
    expect(ai.aiConfig.maxTokens).toBe(4096);
  });
});
