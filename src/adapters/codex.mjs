import crypto from 'node:crypto';
import { inferTerminalFocusTarget, resolveProjectName } from './antigravity.mjs';

/**
 * Adapter for OpenAI Codex CLI (~/.codex/config.toml `notify = [...]`).
 * Codex passes JSON as the final CLI argument (or stdin).
 */
export function handleCodexHook(payload, { env = process.env } = {}) {
  const type = String(payload?.type || 'agent-turn-complete');
  const threadId = payload?.['thread-id'] || payload?.thread_id || 'default';
  const cwd = payload?.cwd || '';
  const project = resolveProjectName(cwd);
  const inputs = Array.isArray(payload?.['input-messages']) ? payload['input-messages'] : [];
  const userPrompt = inputs.length > 0 ? String(inputs[inputs.length - 1] || '') : '';
  const assistantText = String(payload?.['last-assistant-message'] || payload?.last_assistant_message || '');

  const isError = type.includes('error') || type.includes('fail');
  const isAttention = type.includes('approval') || type.includes('permission') || type.includes('input');

  const kind = isError ? 'error' : isAttention ? 'attention' : 'done';
  const title = isError ? 'Codex 执行出错' : isAttention ? 'Codex 等待你的确认' : 'Codex 回合已完成';

  const focusTarget = {
    ...inferTerminalFocusTarget(env, { appName: 'Terminal', bundleId: 'com.apple.Terminal' }),
    windowHint: project,
  };

  return {
    stdout: {},
    event: {
      id: `cdx_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      agent: 'codex',
      agentLabel: 'Codex CLI',
      kind,
      title,
      userPrompt,
      assistantText,
      errorText: isError ? assistantText : '',
      project,
      cwd,
      conversationId: String(threadId),
      durationMs: typeof payload?.duration_ms === 'number' ? payload.duration_ms : null,
      reason: type,
      canceled: false,
      focusTarget,
      meta: { turnId: payload?.['turn-id'] || '' },
    },
  };
}
