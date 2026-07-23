/**
 * pi agent worker：承载按用户隔离、可持久化的 AgentSession。
 *
 * 每个用户的会话文件存放在独立目录中，客户端只接触 sessionId，不能提交文件路径。
 * Agent 仅启用 worktime_query 自定义工具，不再拥有 bash/read 等通用工具。
 */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { PromptScheduler } from './promptScheduler';

let pi: any = null;

interface WorkerSession {
  session: any;
  userId: number;
  sessionFile?: string;
  accessToken: { current: string };
  unsubscribe: () => void;
  lastActiveAt: number;
}

const sessions = new Map<string, WorkerSession>();
const SAFE_CWD = path.resolve(__dirname, '../../data/agent-cwd');
const SESSIONS_ROOT = path.resolve(__dirname, '../../data/agent-sessions');
const IDLE_SESSION_TTL_MS = 30 * 60 * 1000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min ? Math.min(value, max) : fallback;
}

const MAX_RESIDENT_SESSIONS = envInt('AI_MAX_RESIDENT_SESSIONS', 200, 10, 10_000);
const MAX_SESSIONS_PER_USER = envInt('AI_MAX_SESSIONS_PER_USER', 30, 1, 1_000);
const promptScheduler = new PromptScheduler(
  envInt('AI_MAX_CONCURRENT_PROMPTS', 12, 1, 1_000),
  envInt('AI_MAX_QUEUED_PROMPTS', 100, 0, 10_000),
  () => postWorkerStats(),
);

const RESOURCE_CONFIG = {
  my_timesheets: { path: '/timesheets/my', label: '查询我的工时' },
  my_overtime: { path: '/overtime/my', label: '查询我的加班记录' },
  overtime_stats: { path: '/overtime/stats', label: '统计我的加班' },
  my_weekly_reports: { path: '/weekly-reports/my', label: '查询我的周报' },
  weekly_report_by_week: { path: '/weekly-reports/week', label: '查询指定周报' },
  pending_approvals: { path: '/approvals/pending', label: '查询待我审批' },
  my_approval_submissions: { path: '/approvals/my-submissions', label: '查询我的审批进度' },
  approval_history: { path: '/approvals/history', label: '查询审批历史' },
  personal_report: { path: '/reports/personal', label: '查询个人报表' },
  dashboard_report: { path: '/reports/dashboard', label: '查询工作台概况' },
  group_report: { path: '/reports/group', label: '查询本组工时' },
  department_report: { path: '/reports/department', label: '查询部门工时' },
  weekly_timesheet_summary: { path: '/timesheets/weekly-summary', label: '查询个人周工时汇总' },
} as const;

type ResourceName = keyof typeof RESOURCE_CONFIG;

function post(message: any) {
  try {
    parentPort?.postMessage(message);
  } catch {
    try {
      parentPort?.postMessage(JSON.parse(JSON.stringify(message)));
    } catch {
      parentPort?.postMessage({ type: 'error', message: '事件序列化失败' });
    }
  }
}

function postWorkerStats() {
  post({
    type: 'stats',
    stats: { ...promptScheduler.stats(), residentSessions: sessions.size },
  });
}

function userSessionDir(userId: number): string {
  const dir = path.join(SESSIONS_ROOT, String(userId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function assertSessionQuota(existingCount: number, maxSessions = MAX_SESSIONS_PER_USER): void {
  if (!Number.isInteger(existingCount) || existingCount < 0) throw new Error('会话数量无效');
  if (existingCount >= maxSessions) {
    throw new Error(`最多保留${maxSessions}条对话，请先删除不需要的历史对话`);
  }
}

function disposeSession(sessionId: string, record: WorkerSession) {
  record.unsubscribe();
  record.session.dispose?.();
  sessions.delete(sessionId);
  postWorkerStats();
}

function ensureResidentCapacity() {
  if (sessions.size < MAX_RESIDENT_SESSIONS) return;
  const idle = [...sessions.entries()]
    .filter(([, record]) => !record.session.isStreaming)
    .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)[0];
  if (!idle) throw new Error('AI 服务当前会话较多，请稍后重试');
  disposeSession(idle[0], idle[1]);
}

export function buildQueryUrl(worktimeApi: string, resource: ResourceName, params: Record<string, unknown>): string {
  const url = new URL(`${worktimeApi}${RESOURCE_CONFIG[resource].path}`);
  const allowed = ['startDate', 'endDate', 'status', 'weekStart', 'page', 'pageSize', 'userId', 'includeAll'];
  for (const key of allowed) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function createWorktimeQueryTool(accessToken: { current: string }, worktimeApi: string) {
  const resources = Object.keys(RESOURCE_CONFIG) as ResourceName[];
  return pi.defineTool({
    name: 'worktime_query',
    label: '查询工时系统',
    description: [
      '只读查询工时管理系统。根据用户问题选择 resource：',
      'my_timesheets=我的工时，my_overtime/overtime_stats=我的加班，',
      'my_weekly_reports/weekly_report_by_week=我的周报，',
      'pending_approvals/my_approval_submissions/approval_history=审批，',
      'personal_report/dashboard_report=个人报表，group_report/department_report=团队报表，',
      'weekly_timesheet_summary=指定人员周工时。日期格式必须为 YYYY-MM-DD。',
    ].join(''),
    promptSnippet: '使用 worktime_query 查询当前登录用户有权限访问的工时、加班、周报、审批和报表数据。',
    promptGuidelines: [
      '只查询用户明确要求的数据；日期不明确时采用合理的本周或本月范围并在回答中说明。',
      '工具返回权限错误时如实说明，不尝试绕过权限。',
      '工时和加班的单位为天，不要换算成小时。',
    ],
    parameters: Type.Object({
      resource: Type.Union(resources.map((name) => Type.Literal(name))),
      startDate: Type.Optional(Type.String()),
      endDate: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      weekStart: Type.Optional(Type.String()),
      page: Type.Optional(Type.Number({ minimum: 1 })),
      pageSize: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      userId: Type.Optional(Type.Number({ minimum: 1 })),
      includeAll: Type.Optional(Type.Boolean()),
    }),
    executionMode: 'parallel',
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      const resource = params.resource as ResourceName;
      if (!RESOURCE_CONFIG[resource]) throw new Error('不支持的查询类型');
      const url = buildQueryUrl(worktimeApi, resource, params);
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken.current}`, Accept: 'application/json' },
        signal,
      });
      const raw = await response.text();
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error('工时系统返回了无法解析的数据');
      }
      if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
        throw new Error(payload.message || `查询失败（${response.status}）`);
      }
      const data = payload.data ?? payload;
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        details: { resource, label: RESOURCE_CONFIG[resource].label },
      };
    },
  });
}

async function createOrOpenSession(data: {
  requestId: string;
  userId: number;
  pat: string;
  worktimeApi: string;
  piModelsJsonPath: string;
  aiConfig: any;
  sessionId?: string;
}) {
  const { requestId, userId, pat, worktimeApi, piModelsJsonPath, aiConfig, sessionId } = data;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    if (existing.userId !== userId) throw new Error('会话不存在');
    existing.accessToken.current = pat;
    existing.lastActiveAt = Date.now();
    post({ type: 'created', requestId, sessionId, sessionFile: existing.sessionFile, reused: true });
    return;
  }

  ensureResidentCapacity();

  const sessionDir = userSessionDir(userId);
  const available = await pi.SessionManager.list(SAFE_CWD, sessionDir);
  let sessionManager: any;
  if (sessionId) {
    const info = available.find((item: any) => item.id === sessionId);
    if (!info) throw new Error('会话不存在');
    sessionManager = pi.SessionManager.open(info.path, sessionDir, SAFE_CWD);
  } else {
    const knownSessionIds = new Set(available.map((item: any) => item.id));
    for (const [knownSessionId, record] of sessions) {
      if (record.userId === userId) knownSessionIds.add(knownSessionId);
    }
    assertSessionQuota(knownSessionIds.size);
    sessionManager = pi.SessionManager.create(SAFE_CWD, sessionDir);
  }

  const authStorage = pi.AuthStorage.inMemory();
  authStorage.set(aiConfig.piProviderName, { type: 'api_key', key: aiConfig.apiKey });
  const modelRegistry = pi.ModelRegistry.create(authStorage, piModelsJsonPath);
  const model = modelRegistry.find(aiConfig.piProviderName, aiConfig.modelId);
  if (!model) throw new Error(`找不到模型 ${aiConfig.piProviderName}/${aiConfig.modelId}`);

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: SAFE_CWD,
    agentDir: SAFE_CWD,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [
      '你是「工时管理系统」的只读数据助手。使用 worktime_query 查询当前用户有权限访问的数据，并用简洁中文回答。',
      '不要声称已修改、提交或审批任何数据；你没有写入能力。不要暴露访问令牌、接口地址、工具参数或其他技术细节。',
      '回答优先给出结论和关键数字，明细较多时使用短列表；仅在确实适合比较时使用表格。',
    ],
  });
  await resourceLoader.reload();

  const accessToken = { current: pat };
  const queryTool = createWorktimeQueryTool(accessToken, worktimeApi);
  const created = await pi.createAgentSession({
    cwd: SAFE_CWD,
    authStorage,
    modelRegistry,
    model,
    tools: ['worktime_query'],
    customTools: [queryTool],
    resourceLoader,
    sessionManager,
  });
  const session = created.session;
  if (session.sessionFile) {
    await fs.promises.chmod(session.sessionFile, 0o600).catch(() => undefined);
  }
  const unsubscribe = session.subscribe((event: any) => {
    const record = sessions.get(session.sessionId);
    if (record) record.lastActiveAt = Date.now();
    post({ type: 'event', sessionId: session.sessionId, payload: event });
  });
  sessions.set(session.sessionId, {
    session,
    userId,
    sessionFile: session.sessionFile,
    accessToken,
    unsubscribe,
    lastActiveAt: Date.now(),
  });
  postWorkerStats();
  post({ type: 'created', requestId, sessionId: session.sessionId, sessionFile: session.sessionFile, reused: false });
}

async function listSessions(data: { requestId: string; userId: number }) {
  const sessionDir = userSessionDir(data.userId);
  const items = await pi.SessionManager.list(SAFE_CWD, sessionDir);
  const result = items
    .sort((a: any, b: any) => b.modified.getTime() - a.modified.getTime())
    .slice(0, 30)
    .map((item: any) => {
      let messageCount = 0;
      try {
        const manager = pi.SessionManager.open(item.path, sessionDir, SAFE_CWD);
        messageCount = manager.getBranch().filter((entry: any) => {
          if (entry?.type !== 'message') return false;
          const role = entry.message?.role;
          return (role === 'user' || role === 'assistant') && !!messageText(entry.message).trim();
        }).length;
      } catch {
        // 极少数损坏的旧会话仍允许出现在列表中，数量回退为 SDK 原始值。
        messageCount = item.messageCount;
      }
      return {
        id: item.id,
        title: item.name || item.firstMessage || '新对话',
        preview: item.firstMessage || '',
        messageCount,
        createdAt: item.created.toISOString(),
        updatedAt: item.modified.toISOString(),
      };
    });
  post({ type: 'sessions', requestId: data.requestId, sessions: result });
}

export function messageText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text || '')
    .join('');
}

export function serializeHistory(session: any) {
  return (session.messages || []).flatMap((message: any, index: number) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const text = messageText(message).trim();
    if (!text) return [];
    return [{
      id: `history_${index}`,
      role: message.role,
      parts: [{ id: `history_${index}_text`, type: 'text', text, done: true }],
    }];
  });
}

function getOwnedSession(sessionId: string, userId: number): WorkerSession {
  const record = sessions.get(sessionId);
  if (!record || record.userId !== userId) throw new Error('会话不存在');
  record.lastActiveAt = Date.now();
  return record;
}

async function promptSession(data: { requestId: string; sessionId: string; userId: number; message: string }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  await promptScheduler.run(data.sessionId, async () => {
    if (record.session.isStreaming) throw new Error('当前会话正在处理中');
    if (!record.session.sessionManager.getSessionName()) {
      record.session.setSessionName(data.message.trim().slice(0, 30) || '新对话');
    }
    await record.session.prompt(data.message);
  });
  post({ type: 'prompt-done', requestId: data.requestId, sessionId: data.sessionId });
}

export function entryMessageText(entry: any): string {
  if (entry?.type !== 'message' || entry.message?.role !== 'user') return '';
  return messageText(entry.message).trim();
}

async function regenerateSession(data: { requestId: string; sessionId: string; userId: number; message: string }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  await promptScheduler.run(data.sessionId, async () => {
    if (record.session.isStreaming) throw new Error('当前会话正在处理中');
    const branch = record.session.sessionManager.getBranch();
    const lastUserEntry = [...branch].reverse().find((entry: any) => entryMessageText(entry));
    if (!lastUserEntry) throw new Error('没有可重新生成的消息');

    const navigation = await record.session.navigateTree(lastUserEntry.id, { summarize: false });
    if (navigation.cancelled) throw new Error('重新生成已取消');
    const prompt = navigation.editorText?.trim() || data.message.trim();
    if (!prompt) throw new Error('没有可重新生成的消息');
    await record.session.prompt(prompt);
  });
  post({ type: 'prompt-done', requestId: data.requestId, sessionId: data.sessionId });
}

async function queueMessage(data: { requestId: string; sessionId: string; userId: number; message: string; mode: 'steer' | 'followUp' }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  if (!record.session.isStreaming) throw new Error('当前会话没有正在执行的任务');
  if (data.mode === 'steer') await record.session.steer(data.message);
  else await record.session.followUp(data.message);
  post({ type: 'action-done', requestId: data.requestId });
}

async function refreshAccessToken(data: { requestId: string; sessionId: string; userId: number; pat: string }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  record.accessToken.current = data.pat;
  post({ type: 'action-done', requestId: data.requestId });
}

async function abortSession(data: { requestId: string; sessionId: string; userId: number }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  if (!promptScheduler.cancelQueued(data.sessionId)) await record.session.abort();
  post({ type: 'action-done', requestId: data.requestId });
}

async function getHistory(data: { requestId: string; sessionId: string; userId: number }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  post({ type: 'history', requestId: data.requestId, messages: serializeHistory(record.session) });
}

async function renameSession(data: { requestId: string; sessionId: string; userId: number; title: string }) {
  const record = getOwnedSession(data.sessionId, data.userId);
  record.session.setSessionName(data.title.trim().slice(0, 50));
  post({ type: 'action-done', requestId: data.requestId });
}

async function deleteSession(data: { requestId: string; sessionId: string; userId: number }) {
  let sessionFile: string | undefined;
  const record = sessions.get(data.sessionId);
  if (record) {
    if (record.userId !== data.userId) throw new Error('会话不存在');
    sessionFile = record.sessionFile;
    if (!promptScheduler.cancelQueued(data.sessionId) && record.session.isStreaming) await record.session.abort();
    disposeSession(data.sessionId, record);
  } else {
    const available = await pi.SessionManager.list(SAFE_CWD, userSessionDir(data.userId));
    sessionFile = available.find((item: any) => item.id === data.sessionId)?.path;
  }
  if (!sessionFile) throw new Error('会话不存在');
  const resolved = path.resolve(sessionFile);
  const allowedRoot = path.resolve(userSessionDir(data.userId)) + path.sep;
  if (!resolved.startsWith(allowedRoot)) throw new Error('会话路径无效');
  await fs.promises.unlink(resolved).catch((error: any) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  post({ type: 'action-done', requestId: data.requestId });
}

async function handleMessage(message: any) {
  switch (message.type) {
    case 'create': return createOrOpenSession(message);
    case 'list': return listSessions(message);
    case 'history': return getHistory(message);
    case 'prompt': return promptSession(message);
    case 'regenerate': return regenerateSession(message);
    case 'queue': return queueMessage(message);
    case 'refresh-token': return refreshAccessToken(message);
    case 'abort': return abortSession(message);
    case 'rename': return renameSession(message);
    case 'delete': return deleteSession(message);
    default: throw new Error('不支持的 Agent 操作');
  }
}

if (parentPort) {
  parentPort.on('message', (message: any) => {
    handleMessage(message).catch((error: any) => {
      post({
        type: 'error',
        requestId: message?.requestId,
        sessionId: message?.sessionId,
        message: error?.message || 'worker 处理失败',
      });
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, record] of sessions) {
      if (!record.session.isStreaming && now - record.lastActiveAt > IDLE_SESSION_TTL_MS) {
        disposeSession(sessionId, record);
      }
    }
  }, 10 * 60 * 1000);
  cleanupTimer.unref();

  void bootstrap().catch((error) => {
    post({ type: 'error', message: `pi 加载失败：${(error as Error).message}` });
  });
}

async function bootstrap() {
  // Worker 线程不支持设置 process.umask（Node 24 会抛 ERR_WORKER_UNSUPPORTED_OPERATION）。
  // 目录与会话文件改用显式 mode/chmod，避免依赖进程级全局状态。
  fs.mkdirSync(SAFE_CWD, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(SAFE_CWD, 0o700);
  fs.chmodSync(SESSIONS_ROOT, 0o700);
  // 本项目输出 CommonJS，TypeScript 会把普通 import() 降级为 require()；而 pi 包只导出
  // ESM 的 import 条件。通过原生动态 import 保留 ESM 加载语义，避免启动时报
  // “No exports main defined”。模块名是服务端固定常量，不接收用户输入。
  const nativeImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<any>;
  pi = await nativeImport('@earendil-works/pi-coding-agent');
  post({ type: 'ready' });
  postWorkerStats();
}
