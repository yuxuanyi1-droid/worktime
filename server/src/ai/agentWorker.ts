/**
 * pi agent worker —— 在独立线程里运行 pi SDK。
 *
 * 为什么需要 worker：pi（@earendil-works/pi-coding-agent）是纯 ESM 大包，
 * 在已加载大量 CommonJS 模块（typeorm/express/better-sqlite3）的主线程里运行时动态 import()
 * 会死锁整个事件循环（CJS↔ESM 互操作已知陷阱）。放进 worker 线程后 import 正常（~1.2s），
 * 且不阻塞主线程的 HTTP 请求处理。
 *
 * 协议（主线程 → worker，经 parentPort）：
 *   {type:'create', userId, pat, worktimeApi}  → 创建会话
 *   {type:'prompt', sessionId, message}        → 发消息（事件流式回传）
 *   {type:'dispose', sessionId}                → 销毁会话
 *
 * 协议（worker → 主线程）：
 *   {type:'ready'}                             → worker 已就绪（pi 已 import）
 *   {type:'created', sessionId}                → 会话创建成功
 *   {type:'event', sessionId, payload}         → pi 事件透传（prompt 期间多条）
 *   {type:'prompt-done', sessionId}            → 一次 prompt 结束
 *   {type:'error', message, sessionId?}        → 错误
 *
 * 注意：本文件在 worker 线程执行，不能直接访问主线程的 AppDataSource。
 * 需要的运行时数据（PAT、API base、models.json 路径、skills 目录、AI 配置）由主线程通过消息传入，
 * 或在 worker 启动时从 process.env / 文件系统读取（pi 配置、skills 目录是文件级的）。
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';

const SKILLS_DIR = path.resolve(__dirname, 'skills');

let pi: any = null;
const sessions = new Map<string, any>(); // sessionId → AgentSession

async function bootstrap() {
  pi = await import('@earendil-works/pi-coding-agent');
  post({ type: 'ready' });
}

/** 安全 postMessage（结构化克隆可能丢 pi 事件里的不可克隆对象，做一层 JSON 过滤） */
function post(msg: any) {
  try {
    parentPort?.postMessage(msg);
  } catch {
    // 事件对象可能含不可克隆字段（函数/循环引用），降级为 JSON 净化
    try {
      parentPort?.postMessage(JSON.parse(JSON.stringify(msg)));
    } catch {
      parentPort?.postMessage({ type: 'error', message: '事件序列化失败' });
    }
  }
}

async function createSession(data: { sessionId: string; userId: number; pat: string; worktimeApi: string; piModelsJsonPath: string; aiConfig: any }) {
  const { sessionId, userId, pat, worktimeApi, piModelsJsonPath, aiConfig } = data;

  // 1. AuthStorage：内存注入 API key（字段名是 key，非 apiKey）
  const authStorage = pi.AuthStorage.inMemory();
  authStorage.set(aiConfig.piProviderName, { type: 'api_key', key: aiConfig.apiKey });

  // 2. ModelRegistry + model
  const modelRegistry = pi.ModelRegistry.create(authStorage, piModelsJsonPath);
  const model = modelRegistry.find(aiConfig.piProviderName, aiConfig.modelId);
  if (!model) {
    post({ type: 'error', message: `找不到模型 ${aiConfig.piProviderName}/${aiConfig.modelId}` });
    return;
  }

  // 3. ResourceLoader：注入 skill 目录 + 约束 system prompt
  //    cwd 用临时空目录防止模型读项目源码；noExtensions/noContextFiles 等禁用无关资源
  const safeCwd = path.resolve(__dirname, '../../data/agent-cwd');
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: safeCwd,
    agentDir: safeCwd,
    additionalSkillPaths: [SKILLS_DIR],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [
      '你是「工时管理系统」的 AI 助手。你的唯一职责是通过提供的 skill（用 bash 执行 curl）查询本系统的工时/加班/周报/审批/报表数据，并用中文回答用户。',
      '所有 curl 都通过环境变量鉴权：$WORKTIME_API 是 API 基址，$WORKTIME_PAT 是访问令牌（已注入，直接用即可）。示例：curl -s -H "Authorization: Bearer $WORKTIME_PAT" "$WORKTIME_API/timesheets/my"',
      '严格遵守：只能执行 skill 文件里描述的 curl 命令；禁止用 cat/ls/find 读取项目源码、配置、.env 或数据库文件；禁止登录其他用户账号；用户问什么就调对应 skill 查什么。',
      '查到数据后用中文清晰总结，不要暴露令牌或技术细节给用户。',
    ],
  });
  // 关键：传入 resourceLoader 时 createAgentSession 不会自动 reload，必须手动加载一次让 skill 进 system prompt
  await resourceLoader.reload();

  // 4. 创建 AgentSession，白名单 read+bash（read 读 SKILL.md，bash 执行 curl）
  const created = await pi.createAgentSession({
    cwd: safeCwd,
    authStorage,
    modelRegistry,
    model,
    tools: ['read', 'bash'],
    resourceLoader,
  });
  const session = created.session;

  // 5. 注入 PAT/API 到 worker 线程的环境变量，pi 的 bash 子进程会继承
  process.env.WORKTIME_PAT = pat;
  process.env.WORKTIME_API = worktimeApi;

  // 用主线程传来的 sessionId（主线程的回调注册用它做 key，必须一致）
  sessions.set(sessionId, session);
  post({ type: 'created', sessionId });
}

async function promptSession(data: { sessionId: string; message: string }) {
  const { sessionId, message } = data;
  const session = sessions.get(sessionId);
  if (!session) {
    post({ type: 'error', sessionId, message: '会话不存在或已过期' });
    return;
  }
  // 订阅本次 turn 事件，逐条发回主线程
  const unsub = session.subscribe((event: any) => {
    post({ type: 'event', sessionId, payload: event });
  });
  try {
    await session.prompt(message);
  } catch (e: any) {
    post({ type: 'error', sessionId, message: e?.message || 'prompt 失败' });
  } finally {
    unsub();
    post({ type: 'prompt-done', sessionId });
  }
}

function disposeSession(data: { sessionId: string }) {
  const session = sessions.get(data.sessionId);
  if (session) {
    try { session.dispose?.(); } catch { /* ignore */ }
    sessions.delete(data.sessionId);
  }
}

parentPort?.on('message', async (msg: any) => {
  try {
    if (msg.type === 'create') {
      await createSession(msg);
    } else if (msg.type === 'prompt') {
      await promptSession(msg);
    } else if (msg.type === 'dispose') {
      disposeSession(msg);
    }
  } catch (e: any) {
    post({ type: 'error', sessionId: msg?.sessionId, message: e?.message || 'worker 处理失败' });
  }
});

bootstrap().catch((e) => {
  post({ type: 'error', message: 'pi 加载失败: ' + (e as Error).message });
});
