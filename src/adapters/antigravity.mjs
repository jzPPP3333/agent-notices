import path from 'node:path';
import crypto from 'node:crypto';
import { consumeTurnDuration, markTurnStart } from '../store.mjs';
import { extractLastAssistantText } from '../summary.mjs';

export function inferTerminalFocusTarget(env = process.env, fallback = { appName: 'Terminal', bundleId: 'com.apple.Terminal' }) {
  const term = String(env.TERM_PROGRAM || '').toLowerCase();
  if (env.CURSOR_TRACE_ID || term.includes('cursor')) {
    return { appName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' };
  }
  if (term.includes('vscode') || env.VSCODE_IPC_HOOK_CLI) {
    return { appName: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' };
  }
  if (term.includes('iterm')) {
    return { appName: 'iTerm', bundleId: 'com.googlecode.iterm2' };
  }
  if (term.includes('ghostty') || env.GHOSTTY_RESOURCES_DIR) {
    return { appName: 'Ghostty', bundleId: 'com.mitchellh.ghostty' };
  }
  if (term.includes('warp')) {
    return { appName: 'Warp', bundleId: 'dev.warp.Warp-Stable' };
  }
  if (term.includes('wezterm')) {
    return { appName: 'WezTerm', bundleId: 'com.github.wez.wezterm' };
  }
  if (term.includes('kitty') || env.KITTY_WINDOW_ID) {
    return { appName: 'kitty', bundleId: 'net.kovidgoyal.kitty' };
  }
  if (term.includes('apple_terminal')) {
    return { appName: 'Terminal', bundleId: 'com.apple.Terminal' };
  }
  return fallback;
}

export function resolveProjectName(cwd, workspacePaths) {
  const candidate =
    (Array.isArray(workspacePaths) && workspacePaths.length > 0 && workspacePaths[0]) ||
    cwd ||
    '';
  if (!candidate) return 'Workspace';
  const base = path.basename(candidate.replace(/\/+$/, ''));
  return base || candidate;
}

/**
 * Native adapter for Google Antigravity (~/.gemini/config/hooks.json).
 * Strictly follows Antigravity's protojson camelCase stdin/stdout contract.
 */
export function handleAntigravityHook(payload, { eventOverride = null, env = process.env, config = null } = {}) {
  const hookEvent = eventOverride || payload?.hookEventName || 'Stop';
  const conversationId = payload?.conversationId || 'default';
  const sessionKey = `antigravity:${conversationId}`;
  const cwd = payload?.cwd || (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : '') || '';
  const project = resolveProjectName(cwd, payload?.workspacePaths);

  if (hookEvent === 'SessionStart') {
    markTurnStart(sessionKey, { reset: true, metadata: { project, cwd } });
    return { stdout: {}, event: null };
  }

  if (hookEvent === 'PreInvocation') {
    const isFirst = Number(payload?.invocationNum) === 1;
    markTurnStart(sessionKey, { reset: isFirst, metadata: { project, cwd } });
    return { stdout: {}, event: null };
  }

  if (hookEvent === 'PostToolUse') {
    // Only notify immediately on tool error if explicitly wired to PostToolUse
    if (payload?.error) {
      return {
        stdout: {},
        event: {
          id: `agy_${crypto.randomBytes(6).toString('hex')}`,
          timestamp: new Date().toISOString(),
          agent: 'antigravity',
          agentLabel: 'Antigravity',
          kind: 'error',
          title: `工具调用失败：${payload?.toolCall?.name || 'Tool'}`,
          userPrompt: payload?.lastUserInput || '',
          assistantText: '',
          errorText: String(payload.error),
          project,
          cwd,
          conversationId,
          durationMs: null,
          reason: 'TOOL_ERROR',
          canceled: false,
          focusTarget: buildAntigravityFocusTarget(payload, project, env),
          meta: { modelName: payload?.modelName || '' },
        },
      };
    }
    return { stdout: {}, event: null };
  }

  if (hookEvent === 'Stop') {
    const durationMs = consumeTurnDuration(sessionKey);
    const reason = String(payload?.terminationReason || 'NO_TOOL_CALL');
    const errorText = payload?.error ? String(payload.error) : '';
    const canceled = reason === 'USER_CANCELED';

    let kind = 'done';
    let title = '会话任务已完成';

    if (canceled) {
      kind = 'info';
      title = '任务已手动取消';
    } else if (reason === 'ERROR' || errorText) {
      kind = 'error';
      title = '任务执行出错';
    } else if (
      reason === 'MAX_INVOCATIONS' ||
      reason === 'MAX_FORCED_INVOCATIONS' ||
      reason === 'MAX_TOKEN_BUDGET_EXCEEDED' ||
      reason === 'TERMINAL_CUSTOM_HOOK'
    ) {
      kind = 'attention';
      title = '任务触发限制，需要人工查看';
    } else if (payload?.fullyIdle === false) {
      kind = 'done';
      title = '主回合已完成（仍有后台任务）';
    }

    const readTranscript = config?.summary?.readTranscript !== false;
    const assistantText =
      readTranscript && payload?.transcriptPath
        ? extractLastAssistantText(payload.transcriptPath)
        : '';

    return {
      stdout: { decision: 'stop' },
      event: {
        id: `agy_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date().toISOString(),
        agent: 'antigravity',
        agentLabel: 'Antigravity',
        kind,
        title,
        userPrompt: payload?.lastUserInput || '',
        assistantText,
        errorText,
        project,
        cwd,
        conversationId,
        durationMs,
        reason,
        canceled,
        focusTarget: buildAntigravityFocusTarget(payload, project, env),
        meta: {
          modelName: payload?.modelName || '',
          fullyIdle: payload?.fullyIdle ?? true,
        },
      },
    };
  }

  return { stdout: {}, event: null };
}

function buildAntigravityFocusTarget(payload, project, env) {
  const transcript = String(payload?.transcriptPath || '');
  const isCli = transcript.includes('antigravity-cli');
  if (isCli) {
    const base = inferTerminalFocusTarget(env, { appName: 'Terminal', bundleId: 'com.apple.Terminal' });
    return { ...base, windowHint: project };
  }
  return {
    appName: 'Antigravity',
    bundleId: 'com.google.antigravity',
    windowHint: project,
  };
}
