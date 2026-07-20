import crypto from 'node:crypto';

const SEND_PATH = '/oppo-mtp/oppo-robot/messages/send';
const BATCH_SEND_PATH = '/oppo-mtp/oppo-robot/messages/batchSend';
const MAX_BATCH_SIZE = 2000;

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
}

type FetchLike = (input: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface TtRobotDependencies {
  fetch: FetchLike;
  now: () => number;
  nonce: () => string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
      batchSize: Math.min(Math.max(1, config.batchSize), MAX_BATCH_SIZE),
    };
    // 通道关闭时完全忽略其余配置，避免未启用的可选集成影响站内通知。
    this.endpoint = config.enabled
      ? this.parseEndpoint(config.baseUrl)
      : new URL('https://apimarket.myoas.com');
    this.dependencies = {
      fetch: dependencies.fetch ?? (fetch as FetchLike),
      now: dependencies.now ?? Date.now,
      nonce: dependencies.nonce ?? (() => String(crypto.randomInt(100000, 1000000))),
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
        throw new Error(`TT 机器人接口请求失败（HTTP ${response.status}）：${responseText.slice(0, 500)}`);
      }
      return data;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`TT 机器人接口请求超时（${this.config.timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
