import request from '../utils/request';

export interface AgentSessionSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: {
    id: string;
    type: 'text';
    text: string;
    done: true;
  }[];
}

export const agentApi = {
  getSessions: () =>
    request.get<any, { code: number; data: AgentSessionSummary[] }>('/agent/sessions'),
  createSession: () =>
    request.post<any, { code: number; data: { id: string; title: string } }>('/agent/sessions'),
  getHistory: (sessionId: string) =>
    request.get<any, { code: number; data: AgentHistoryMessage[] }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
    ),
  renameSession: (sessionId: string, title: string) =>
    request.patch<any, { code: number; data: { id: string; title: string } }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}`,
      { title },
    ),
  deleteSession: (sessionId: string) =>
    request.delete<any, { code: number }>(`/agent/sessions/${encodeURIComponent(sessionId)}`),
  abortSession: (sessionId: string) =>
    request.post<any, { code: number }>(`/agent/sessions/${encodeURIComponent(sessionId)}/abort`),
  queueMessage: (sessionId: string, message: string, mode: 'steer' | 'followUp' = 'followUp') =>
    request.post<any, { code: number }>(`/agent/sessions/${encodeURIComponent(sessionId)}/queue`, {
      message,
      mode,
    }),
};
