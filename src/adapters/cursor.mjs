import crypto from 'node:crypto';
import { consumeTurnDuration, markTurnStart } from '../store.mjs';
import { resolveProjectName } from './antigravity.mjs';

/**
 * Adapter for Cursor (~/.cursor/hooks.json).
 */
export function handleCursorHook(payload, { eventOverride = null } = {}) {
  const hookEvent = eventOverride || payload?.hook_event_name || 'stop';
  const convId = payload?.conversation_id || payload?.generation_id || 'default';
  const sessionKey = `cursor:${convId}`;
  const cwd = (Array.isArray(payload?.workspace_roots) && payload.workspace_roots[0]) || payload?.cwd || '';
  const project = resolveProjectName(cwd, payload?.workspace_roots);

  if (hookEvent === 'beforeSubmitPrompt') {
    markTurnStart(sessionKey, { reset: true, metadata: { project, cwd } });
    return { stdout: { continue: true }, event: null };
  }

  if (hookEvent === 'stop' || hookEvent === 'afterAgentResponse') {
    const durationMs = consumeTurnDuration(sessionKey);
    const status = String(payload?.status || 'completed').toLowerCase();
    const canceled = status === 'aborted' || status === 'canceled';
    const isError = status === 'error' || status === 'failed';

    return {
      stdout: {},
      event: {
        id: `cur_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date().toISOString(),
        agent: 'cursor',
        agentLabel: 'Cursor',
        kind: canceled ? 'info' : isError ? 'error' : 'done',
        title: canceled ? 'Cursor 任务已取消' : isError ? 'Cursor 执行出错' : 'Cursor 任务已完成',
        userPrompt: payload?.prompt || '',
        assistantText: payload?.text || payload?.response || '',
        errorText: isError ? String(payload?.error || payload?.text || '未知错误') : '',
        project,
        cwd,
        conversationId: String(convId),
        durationMs,
        reason: status,
        canceled,
        focusTarget: {
          appName: 'Cursor',
          bundleId: 'com.todesktop.230313mzl4w4u92',
          windowHint: project,
        },
        meta: { status },
      },
    };
  }

  return { stdout: {}, event: null };
}
