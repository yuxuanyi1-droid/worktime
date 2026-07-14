import './env';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * AI / pi agent 配置。
 *
 * 通过环境变量配置底层 LLM 提供商，支持：
 * - anthropic（官方或代理：AI_BASE_URL 给定即转发 Anthropic 请求到代理）
 * - openai（官方或兼容：AI_BASE_URL 给定即覆盖 OpenAI endpoint）
 * - custom（DeepSeek / 智谱 / OneAPI / vLLM 等任意 OpenAI/Anthropic 兼容服务）
 *
 * 启动时根据配置生成 pi 用的 models.json（写到 server/data/pi-models.json），
 * 供 agentRunner 的 ModelRegistry 加载。
 *
 * 缺失 AI_API_KEY 时打印警告但**不阻止启动**——聊天端点会返回友好错误，其他功能不受影响。
 */

export type AiProvider = 'anthropic' | 'openai' | 'custom';
export type AiApiType = 'anthropic-messages' | 'openai-completions' | 'openai-responses';

const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase() as AiProvider;
const apiKey = process.env.AI_API_KEY || '';
const baseUrl = (process.env.AI_BASE_URL || '').trim();
const modelId = (process.env.AI_MODEL || '').trim();
const modelName = (process.env.AI_MODEL_NAME || '').trim();

/** 推断 API 协议：显式配置优先，否则按 provider 默认 */
function resolveApiType(): AiApiType {
  const explicit = (process.env.AI_API_TYPE || '').trim() as AiApiType;
  if (explicit) return explicit;
  return provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
}

const apiType = resolveApiType();
const contextWindow = parseInt(process.env.AI_CONTEXT_WINDOW || '128000', 10);
const maxTokens = parseInt(process.env.AI_MAX_TOKENS || '16384', 10);

/** PI_MODELS_JSON 路径（固定在 data 目录），由 ensurePiModelsJson 写入 */
const dataDir = path.resolve(__dirname, '../../data');
export const piModelsJsonPath = path.join(dataDir, 'pi-models.json');

/** 在 pi 内部用的 provider 名（custom 场景用，避免与内置名冲突） */
const PI_PROVIDER_NAME = 'worktime-llm';

/**
 * 生成 pi 的 models.json 内容。
 *
 * 三种策略：
 * - anthropic + baseUrl：覆盖内置 anthropic provider 的 baseUrl（走代理，保留内置模型）
 * - openai + baseUrl：覆盖内置 openai provider 的 baseUrl
 * - custom：注册全新 provider，必须给出 baseUrl + api + models[]
 */
function buildModelsJson(): Record<string, unknown> | null {
  // 通用模型条目（custom provider 必填）
  const modelEntry = (id: string) => ({
    id,
    name: modelName || id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow,
    maxTokens: maxTokens,
  });

  if (provider === 'anthropic') {
    // 覆盖内置 anthropic provider 的 baseUrl（可选）；apiKey 经 AuthStorage 注入
    const providers: Record<string, any> = {
      anthropic: { ...(baseUrl ? { baseUrl } : {}) },
    };
    // 若指定了自定义模型 id，追加到 anthropic provider 的 models 列表
    if (modelId) {
      providers.anthropic.models = [modelEntry(modelId)];
    }
    return { providers };
  }

  if (provider === 'openai') {
    const providers: Record<string, any> = {
      openai: { ...(baseUrl ? { baseUrl } : {}) },
    };
    if (modelId) {
      providers.openai.models = [modelEntry(modelId)];
    }
    return { providers };
  }

  // custom：必须给 baseUrl + modelId
  if (!baseUrl) {
    logger.error('[ai] AI_PROVIDER=custom 必须配置 AI_BASE_URL');
    return null;
  }
  if (!modelId) {
    logger.error('[ai] AI_PROVIDER=custom 必须配置 AI_MODEL');
    return null;
  }
  return {
    providers: {
      [PI_PROVIDER_NAME]: {
        baseUrl,
        api: apiType,
        compat: { supportsDeveloperRole: false },
        models: [modelEntry(modelId)],
      },
    },
  };
}

/** models.json 内容（启动时计算一次） */
const modelsJsonContent = buildModelsJson();

/** 当前选中的模型（provider + modelId），供 agentRunner 传给 createAgentSession */
function resolveSelectedModel(): { provider: string; modelId: string } | null {
  if (provider === 'custom') {
    return { provider: PI_PROVIDER_NAME, modelId };
  }
  // anthropic / openai：模型 id 缺省时给一个合理默认
  const defaultId = provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  return { provider, modelId: modelId || defaultId };
}

export const selectedModel = resolveSelectedModel();

/**
 * AI 是否就绪（apiKey + models.json 都有效）。
 * 未就绪时聊天端点返回 503，其他业务功能不受影响。
 */
export const aiReady = !!(apiKey && modelsJsonContent && selectedModel);

/**
 * 把 models.json 写到 data 目录，返回写入路径；未就绪则跳过。
 * 由 app 启动时调用一次。
 */
export function ensurePiModelsJson(): void {
  if (!modelsJsonContent) return;
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(piModelsJsonPath, JSON.stringify(modelsJsonContent, null, 2), 'utf8');
    logger.info({ path: piModelsJsonPath, provider, modelId: selectedModel?.modelId }, '[ai] pi models.json 已生成');
  } catch (e) {
    logger.error({ err: e }, '[ai] 写 pi-models.json 失败');
  }
}

export const aiConfig = {
  provider,
  apiKey,
  baseUrl,
  apiType,
  modelId: selectedModel?.modelId || '',
  /** pi 内部 provider 名（agentRunner 用） */
  piProviderName: selectedModel?.provider || '',
  contextWindow,
  maxTokens,
  ready: aiReady,
};

if (!aiReady) {
  logger.warn('[ai] AI 未就绪（缺少 AI_API_KEY 或配置不完整），/agent/chat 将不可用。其他功能不受影响。');
}
