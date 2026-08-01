/**
 * AI 助手错误的用户侧安全分类。
 *
 * 自 routes/agent.ts 迁移：worker 侧（agentRunner）与 HTTP 路由共用同一分类函数，
 * 避免 agentRunner → agent 路由的循环依赖；同时保证日志与下发给浏览器的文案一致。
 */

export function presentAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const safeMessages = [
    /^会话不存在$/,
    /^当前会话正在处理中$/,
    /^当前会话没有正在执行的任务$/,
    /^该会话已在其他窗口处理中$/,
    /^该会话正在其他实例处理中，请稍后重试$/,
    /^任务已取消$/,
    /^没有可重新生成的消息$/,
    /^重新生成已取消$/,
    /^最多保留\d+条对话，请先删除不需要的历史对话$/,
    /^AI 服务当前任务较多，请稍后重试$/,
  ];
  if (safeMessages.some(pattern => pattern.test(message))) return message;
  if (/超时|timeout/i.test(message)) return 'AI 处理超时，请稍后重试';
  if (/429|rate.?limit|too many requests|限流|频繁/i.test(message)) return 'AI 模型服务繁忙，请稍后重试';
  if (/找不到模型|pi 加载失败|模型配置/i.test(message)) return 'AI 模型配置不可用，请联系管理员';
  return 'AI 处理失败，请稍后重试';
}
