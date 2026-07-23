#!/usr/bin/env node

/**
 * AI 完整链路烟测：登录 → 状态 → 创建会话 → SSE 生成 → 历史 → 删除。
 *
 * 使用：
 *   AI_SMOKE_BASE_URL=http://127.0.0.1:3000/worktime/api/v1 \
 *   AI_SMOKE_USERNAME=admin AI_SMOKE_PASSWORD=123456 \
 *   node tests/smoke/ai-api-smoke.mjs
 *
 * 脚本不会输出 JWT、密码、模型原文或业务查询结果。
 */

const baseUrl = (process.env.AI_SMOKE_BASE_URL || 'http://127.0.0.1:3000/worktime/api/v1').replace(/\/+$/, '');
const username = process.env.AI_SMOKE_USERNAME || 'admin';
const password = process.env.AI_SMOKE_PASSWORD || '123456';
const question = process.env.AI_SMOKE_QUESTION || '请简短告诉我：我有几条待审批？';

async function jsonRequest(path, init = {}, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) {
    throw new Error(`${path} 失败（${response.status}）：${payload.message || '响应无有效错误信息'}`);
  }
  return payload.data;
}

function parseSseChunk(buffer, onEvent) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  let rest = normalized;
  let separator;
  while ((separator = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    const data = frame.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^\s/, ''))
      .join('\n');
    if (data) onEvent(JSON.parse(data));
  }
  return rest;
}

async function streamChat(sessionId, token) {
  const response = await fetch(`${baseUrl}/agent/chat`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionId, message: question }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw new Error(`聊天接口失败（${response.status}）`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let assistantEventCount = 0;
  let toolEventCount = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    buffer = parseSseChunk(buffer, event => {
      if (event.type === 'error') throw new Error(event.message || 'AI 返回错误');
      if (Array.isArray(event.message?.content) && event.message.content.some(
        item => item?.type === 'thinking' && item.thinking,
      )) throw new Error('SSE 泄露了原始推理内容');
      if (event.assistantMessageEvent?.delta || event.assistantMessageEvent?.thinking) {
        throw new Error('SSE 泄露了原始推理增量');
      }
      if (event.type === 'done') done = true;
      if (event.message?.role === 'assistant') assistantEventCount += 1;
      if (event.type === 'tool_execution_start') toolEventCount += 1;
    });
  }
  if (!done) throw new Error('SSE 未收到 done 终帧');
  if (assistantEventCount === 0) throw new Error('SSE 未收到助手正文事件');
  return { assistantEventCount, toolEventCount };
}

let sessionId;
let token;
try {
  const login = await jsonRequest('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  token = login?.token;
  if (!token) throw new Error('登录响应缺少 token');

  const status = await jsonRequest('/agent/status', {}, token);
  if (!status?.enabled) throw new Error('AI 运行态未就绪');

  const session = await jsonRequest('/agent/sessions', { method: 'POST', body: '{}' }, token);
  sessionId = session?.id;
  if (!sessionId) throw new Error('创建会话响应缺少 id');

  const streamed = await streamChat(sessionId, token);
  const history = await jsonRequest(`/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {}, token);
  if (!Array.isArray(history) || history.length < 2) throw new Error('会话历史未持久化完整问答');

  await jsonRequest(`/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, token);
  sessionId = undefined;
  process.stdout.write(`${JSON.stringify({ ok: true, historyMessages: history.length, ...streamed })}\n`);
} catch (error) {
  process.stderr.write(`AI_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (sessionId && token) {
    await jsonRequest(`/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, token).catch(() => undefined);
  }
}
