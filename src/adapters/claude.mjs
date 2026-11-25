import crypto from 'node:crypto';
import { consumeTurnDuration, markTurnStart } from '../store.mjs';
import { extractClaudeTranscriptInfo } from '../summary.mjs';
import { inferTerminalFocusTarget, resolveProjectName } from './antigravity.mjs';

export function resolveClaudeFocusTarget({ entrypoint = '', project = 'Workspace', env = process.env } = {}) {
  const ep = String(entrypoint || env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase();
  if (ep.includes('desktop')) {
    return {
      appName: 'Claude',
      bundleId: 'com.anthropic.claudefordesktop',
      windowHint: project,
    };
  }
  if (ep.includes('cursor')) {
    return {
      appName: 'Cursor',
      bundleId: 'com.todesktop.230313mzl4w4u92',
      windowHint: project,
    };
  }
  if (ep.includes('vscode') || ep.includes('ide')) {
    return {
      appName: 'Visual Studio Code',
      bundleId: 'com.microsoft.VSCode',
      windowHint: project,
    };
  }
  // If launched from a desktop host with no TERM_PROGRAM set, prefer Claude Desktop when env hints exist
  if (!env.TERM_PROGRAM && (env.CLAUDE_DESKTOP || env.CLAUDE_CODE_SESSION_ACCESS_TOKEN)) {
    return {
      appName: 'Claude',
      bundleId: 'com.anthropic.claudefordesktop',
      windowHint: project,
    };
  }
  return {
    ...inferTerminalFocusTarget(env, { appName: 'Terminal', bundleId: 'com.apple.Terminal' }),
    windowHint: project,
  };
}

/**
 * Adapter for Anthropic Claude Code (~/.claude/settings.json hooks).
 * Supports CLI terminals, VS Code / Cursor extensions, and Claude Desktop (claude-desktop-3p).
 */
export function handleClaudeHook(payload, { eventOverride = null, env = process.env, config = null } = {}) {
  const hookEvent = eventOverride || payload?.hook_event_name || 'Stop';
  const sessionId = payload?.session_id || 'default';
  const sessionKey = `claude:${sessionId}`;
  const cwd = payload?.cwd || '';
  const project = resolveProjectName(cwd);

  if (hookEvent === 'UserPromptSubmit' || hookEvent === 'SessionStart') {
    markTurnStart(sessionKey, { reset: true, metadata: { project, cwd } });
    return { stdout: {}, event: null };
  }

  const readTranscript = config?.summary?.readTranscript !== false;
  const transcriptInfo =
    payload?.transcript_path
      ? extractClaudeTranscriptInfo(payload.transcript_path)
      : { text: '', entrypoint: '', isSidechain: false };

  const focusTarget = resolveClaudeFocusTarget({
    entrypoint: payload?.entrypoint || transcriptInfo.entrypoint,
    project,
    env,
  });

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
        isSubagent: false,
        waitingBackground: false,
        focusTarget,
        meta: { notificationType: nType, entrypoint: transcriptInfo.entrypoint },
      },
    };
  }

  if (hookEvent === 'Stop' || hookEvent === 'SubagentStop') {
    if (payload?.stop_hook_active) {
      return { stdout: {}, event: null };
    }
    const isSubagent = Boolean(
      hookEvent === 'SubagentStop' ||
      payload?.agent_id ||
      payload?.is_sidechain ||
      transcriptInfo.isSidechain
    );
    const durationMs = isSubagent ? null : consumeTurnDuration(sessionKey);
    const assistantText =
      payload?.last_assistant_message ||
      (readTranscript ? transcriptInfo.text : '');

    return {
      stdout: {},
      event: {
        id: `cc_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date().toISOString(),
        agent: 'claude',
        agentLabel: 'Claude Code',
        kind: 'done',
        title: isSubagent ? '子代理任务已完成' : '会话任务已完成',
        userPrompt: '',
        assistantText,
        errorText: '',
        project,
        cwd,
        conversationId: sessionId,
        durationMs,
        reason: hookEvent,
        canceled: false,
        isSubagent,
        waitingBackground: false,
        focusTarget,
        meta: { entrypoint: transcriptInfo.entrypoint },
      },
    };
  }

  return { stdout: {}, event: null };
}
