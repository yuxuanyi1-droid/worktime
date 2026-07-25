import crypto from 'node:crypto';

const SEND_PATH = '/oppo-mtp/oppo-robot/messages/send';
const BATCH_SEND_PATH = '/oppo-mtp/oppo-robot/messages/batchSend';
const MAX_BATCH_SIZE = 2000;
/** 单次重试退避的上限，防止指数增长拉到过长等待。 */
const RETRY_DELAY_CAP_MS = 30_000;
/** 可配置项的硬上限，防止环境变量误配拖垮进程。 */
const MAX_RETRIES_CAP = 5;
const MAX_RETRY_BASE_DELAY_MS = 10_000;
const MAX_BATCH_INTERVAL_MS = 30_000;

export type TtMessageType = 1 | 2 | 5 | 6 | 8 | 23 | 28;

export interface TtMessage {
  type: TtMessageType;
  msg: Record<string, unknown>;
}

export interface TtRobotConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  robotId: string;
  baseUrl: string;
  envId?: string;
  timeoutMs: number;
  batchSize: number;
  /** 单次请求的最大重试次数（不含首次），0 表示不重试。 */
  maxRetries: number;
  /** 指数退避基准延迟（ms），实际退避按 2^attempt 增长并叠加抖动。 */
  retryBaseDelayMs: number;
  /** 批量发送时每批之间的间隔（ms），用于限流。 */
  batchIntervalMs: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** TT 接口返回非 2xx 时抛出，携带 HTTP 状态码供重试策略判断是否可重试。 */
export class TtResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'TtResponseError';
  }
}

/** 判断错误是否值得重试：5xx 服务端错误与网络/超时错误可重试；4xx 客户端错误不重试。 */
function isRetryableTtError(error: unknown): boolean {
  if (error instanceof TtResponseError) {
    return error.status >= 500;
  }
  // 未拿到响应（连接拒绝、DNS 解析失败、请求超时等）均视为瞬时故障，允许重试。
  return true;
}

interface TtRobotDependencies {
  fetch: FetchLike;
  now: () => number;
  nonce: () => string;
  sleep: (ms: number) => Promise<void>;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 将可配置数值收敛到安全区间；非有限值（含 undefined/NaN）回退到 fallback。
 *  确保 maxRetries 等始终为合法数值，使重试/限流循环不变量恒成立，兜底分支不可达。 */
function clampOption(value: number | undefined, min: number, max: number, fallback: number): number {
  const safe = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(min, safe), max);
}

/** 从环境变量读取 TT 机器人配置；默认关闭，不影响站内通知。 */
export function loadTtRobotConfig(): TtRobotConfig {
  return {
    enabled: process.env.TT_NOTIFICATION_ENABLED === 'true',
    appId: process.env.TT_APP_ID?.trim() || '',
    appSecret: process.env.TT_APP_SECRET || '',
    robotId: process.env.TT_ROBOT_ID?.trim() || '',
    baseUrl: process.env.TT_API_BASE_URL?.trim() || 'https://apimarket.myoas.com',
    envId: process.env.TT_ENV_ID?.trim() || undefined,
    timeoutMs: parsePositiveInteger(process.env.TT_REQUEST_TIMEOUT_MS, 5000),
    batchSize: Math.min(parsePositiveInteger(process.env.TT_BATCH_SIZE, MAX_BATCH_SIZE), MAX_BATCH_SIZE),
    maxRetries: Math.min(parsePositiveInteger(process.env.TT_MAX_RETRIES, 3), MAX_RETRIES_CAP),
    retryBaseDelayMs: Math.min(parsePositiveInteger(process.env.TT_RETRY_BASE_DELAY_MS, 300), MAX_RETRY_BASE_DELAY_MS),
    batchIntervalMs: Math.min(parsePositiveInteger(process.env.TT_BATCH_INTERVAL_MS, 200), MAX_BATCH_INTERVAL_MS),
  };
}

/**
 * TT 魔盒接口签名：Base64(HmacSHA1(METHOD&HOST&URL&APP_ID&TIMESTAMP&NONCE, AppSecret))。
 */
export function buildTtSignature(input: {
  appSecret: string;
  method: string;
  host: string;
  path: string;
  appId: string;
  timestamp: string;
  nonce: string;
}): string {
  const signText = [
    input.method.toUpperCase(),
    input.host,
    input.path,
    input.appId,
    input.timestamp,
    input.nonce,
  ].join('&');
  return crypto.createHmac('sha1', input.appSecret).update(signText).digest('base64');
}

/** TT 机器人 HTTP 客户端，可被后续业务直接用于文本、富文本、卡片等消息。 */
export class TtRobotClient {
  private readonly config: TtRobotConfig;
  private readonly dependencies: TtRobotDependencies;
  private readonly endpoint: URL;

  constructor(
    config: TtRobotConfig = loadTtRobotConfig(),
    dependencies: Partial<TtRobotDependencies> = {},
  ) {
    this.config = {
      ...config,
      batchSize: clampOption(config.batchSize, 1, MAX_BATCH_SIZE, MAX_BATCH_SIZE),
      maxRetries: clampOption(config.maxRetries, 0, MAX_RETRIES_CAP, 3),
      retryBaseDelayMs: clampOption(config.retryBaseDelayMs, 0, MAX_RETRY_BASE_DELAY_MS, 300),
      batchIntervalMs: clampOption(config.batchIntervalMs, 0, MAX_BATCH_INTERVAL_MS, 200),
    };
    // 通道关闭时完全忽略其余配置，避免未启用的可选集成影响站内通知。
    this.endpoint = config.enabled
      ? this.parseEndpoint(config.baseUrl)
      : new URL('https://apimarket.myoas.com');
    this.dependencies = {
      fetch: dependencies.fetch ?? (fetch as FetchLike),
      now: dependencies.now ?? Date.now,
      nonce: dependencies.nonce ?? (() => String(crypto.randomInt(100000, 1000000))),
      sleep: dependencies.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms))),
    };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 向单个工号或群组发送消息。receiveType：1=个人，2=群组。 */
  async sendMessage(receiveId: string, message: TtMessage, receiveType: 1 | 2 = 1): Promise<unknown> {
    const normalizedId = receiveId.trim();
    if (!normalizedId) throw new Error('TT 接收对象不能为空');
    return this.request(SEND_PATH, {
      msg: message.msg,
      from: { pub: this.config.robotId },
      to: { receiveId: normalizedId, receiveType },
      type: message.type,
    });
  }

  /** 批量发送，自动去重并按接口上限分批，每批最多 2000 人。 */
  async batchSendMessages(receiveIds: string[], message: TtMessage): Promise<unknown[]> {
    const uniqueIds = Array.from(new Set(receiveIds.map(id => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return [];

    const responses: unknown[] = [];
    for (let start = 0; start < uniqueIds.length; start += this.config.batchSize) {
      // 批次间限流，避免高并发压垮下游；首批无延迟，末批后也不再 sleep。
      if (start > 0 && this.config.batchIntervalMs > 0) {
        await this.dependencies.sleep(this.config.batchIntervalMs);
      }
      const users = uniqueIds.slice(start, start + this.config.batchSize);
      responses.push(await this.request(BATCH_SEND_PATH, {
        msg: message.msg,
        from: { pub: this.config.robotId },
        to: [{ user: users }],
        type: message.type,
      }));
    }
    return responses;
  }

  async sendText(receiveId: string, text: string, receiveType: 1 | 2 = 1): Promise<unknown> {
    return this.sendMessage(receiveId, { type: 2, msg: { text } }, receiveType);
  }

  async batchSendText(receiveIds: string[], text: string): Promise<unknown[]> {
    return this.batchSendMessages(receiveIds, { type: 2, msg: { text } });
  }

  private parseEndpoint(baseUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('TT_API_BASE_URL 格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('TT_API_BASE_URL 必须是可信的 HTTP(S) 地址');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('TT_API_BASE_URL 只能配置协议和域名，不应包含路径或查询参数');
    }
    return parsed;
  }

  private ensureConfigured(): void {
    if (!this.config.enabled) throw new Error('TT 机器人通知未启用');
    const missing = [
      ['TT_APP_ID', this.config.appId],
      ['TT_APP_SECRET', this.config.appSecret],
      ['TT_ROBOT_ID', this.config.robotId],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`TT 机器人配置缺失：${missing.join('、')}`);
  }

  private buildHeaders(path: string): Record<string, string> {
    const timestamp = String(Math.floor(this.dependencies.now() / 1000));
    const nonce = this.dependencies.nonce();
    const headers: Record<string, string> = {
      appid: this.config.appId,
      nonce,
      timestamp,
      sign: buildTtSignature({
        appSecret: this.config.appSecret,
        method: 'POST',
        host: this.endpoint.hostname,
        path,
        appId: this.config.appId,
        timestamp,
        nonce,
      }),
      signversion: '2.0.0',
      'Content-Type': 'application/json',
    };
    if (this.config.envId) headers.envid = this.config.envId;
    return headers;
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    this.ensureConfigured();
    // 有界重试：仅对网络/超时/5xx 错误重试，4xx 等客户端错误立即失败。
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.singleRequest(path, body);
      } catch (error) {
        if (!isRetryableTtError(error) || attempt === this.config.maxRetries) {
          throw error;
        }
        await this.dependencies.sleep(this.computeBackoff(attempt));
      }
    }
    // 循环仅在 maxRetries < 0 时才会到达，构造函数已保证 maxRetries >= 0。
    throw new Error('TT 请求重试逻辑异常');
  }

  /** 指数退避 + 抖动，避免下游抖动时多个实例同步重试（惊群效应）。 */
  private computeBackoff(attempt: number): number {
    const exponential = this.config.retryBaseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exponential, RETRY_DELAY_CAP_MS);
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.max(1, Math.floor(capped * jitter));
  }

  private async singleRequest(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref();

    try {
      const response = await this.dependencies.fetch(new URL(path, this.endpoint).toString(), {
        method: 'POST',
        headers: this.buildHeaders(path),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let data: unknown = responseText;
      if (responseText) {
        try { data = JSON.parse(responseText); } catch { /* 保留原始文本 */ }
      }
      if (!response.ok) {
        throw new TtResponseError(
          response.status,
          `TT 机器人接口请求失败（HTTP ${response.status}）：${responseText.slice(0, 500)}`,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof TtResponseError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new Error(`TT 机器人接口请求超时（${this.config.timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
