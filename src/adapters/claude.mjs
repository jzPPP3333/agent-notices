import crypto from 'node:crypto';
import { consumeTurnDuration, markTurnStart } from '../store.mjs';
import { extractLastAssistantText } from '../summary.mjs';
import { inferTerminalFocusTarget, resolveProjectName } from './antigravity.mjs';

/**
 * Adapter for Anthropic Claude Code (~/.claude/settings.json hooks).
 */
export function handleClaudeHook(payload, { eventOverride = null, env = process.env, config = null } = {}) {
  const hookEvent = eventOverride || payload?.hook_event_name || 'Stop';
  const sessionId = payload?.session_id || 'default';
  const sessionKey = `claude:${sessionId}`;
  const cwd = payload?.cwd || '';
  const project = resolveProjectName(cwd);
  const focusTarget = {
    ...inferTerminalFocusTarget(env, { appName: 'Terminal', bundleId: 'com.apple.Terminal' }),
    windowHint: project,
  };

  if (hookEvent === 'UserPromptSubmit' || hookEvent === 'SessionStart') {
    markTurnStart(sessionKey, { reset: true, metadata: { project, cwd } });
    return { stdout: {}, event: null };
  }

  if (hookEvent === 'Notification') {
    const nType = String(payload?.notification_type || 'notification');
    let title = '需要你的关注';
    if (nType === 'permission_prompt') {
      title = '等待授权审批';
    } else if (nType === 'idle_prompt') {
      title = '等待继续输入';
    } else if (nType === 'elicitation_dialog') {
      title = '等待回答问题';
    }

    return {
      stdout: {},
      event: {
        id: `cc_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date().toISOString(),
        agent: 'claude',
        agentLabel: 'Claude Code',
        kind: 'attention',
        title,
        userPrompt: '',
        assistantText: payload?.message || payload?.title || '',
        errorText: '',
        project,
        cwd,
        conversationId: sessionId,
        durationMs: null,
        reason: nType,
        canceled: false,
        focusTarget,
        meta: { notificationType: nType },
      },
    };
  }

  if (hookEvent === 'Stop' || hookEvent === 'SubagentStop') {
    if (payload?.stop_hook_active) {
      return { stdout: {}, event: null };
    }
    const durationMs = consumeTurnDuration(sessionKey);
    const readTranscript = config?.summary?.readTranscript !== false;
    const assistantText =
      payload?.last_assistant_message ||
      (readTranscript && payload?.transcript_path ? extractLastAssistantText(payload.transcript_path) : '');

    return {
      stdout: {},
      event: {
        id: `cc_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date().toISOString(),
        agent: 'claude',
        agentLabel: 'Claude Code',
        kind: 'done',
        title: hookEvent === 'SubagentStop' ? '子代理任务已完成' : '会话任务已完成',
        userPrompt: '',
        assistantText,
        errorText: '',
        project,
        cwd,
        conversationId: sessionId,
        durationMs,
        reason: hookEvent,
        canceled: false,
        isSubagent: hookEvent === 'SubagentStop',
        waitingBackground: false,
        focusTarget,
        meta: {},
      },
    };
  }

  return { stdout: {}, event: null };
}
