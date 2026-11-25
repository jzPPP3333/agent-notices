import { handleAntigravityHook } from './antigravity.mjs';
import { handleClaudeHook } from './claude.mjs';
import { handleCodexHook } from './codex.mjs';
import { handleCursorHook } from './cursor.mjs';

export function detectAgentFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'antigravity';
  if ('conversationId' in payload || 'hookEventName' in payload || 'terminationReason' in payload) {
    return 'antigravity';
  }
  if ('session_id' in payload || 'hook_event_name' in payload || 'transcript_path' in payload) {
    if ('workspace_roots' in payload || 'generation_id' in payload) return 'cursor';
    return 'claude';
  }
  if ('thread-id' in payload || 'last-assistant-message' in payload || payload.type === 'agent-turn-complete') {
    return 'codex';
  }
  if ('workspace_roots' in payload || 'conversation_id' in payload) {
    return 'cursor';
  }
  return 'antigravity';
}

export function adaptHookEvent(agentName, payload, options = {}) {
  const normalized = String(agentName || 'auto').toLowerCase();
  const target = normalized === 'auto' ? detectAgentFromPayload(payload) : normalized;

  switch (target) {
    case 'antigravity':
    case 'agy':
      return handleAntigravityHook(payload, options);
    case 'claude':
    case 'claude-code':
      return handleClaudeHook(payload, options);
    case 'codex':
      return handleCodexHook(payload, options);
    case 'cursor':
      return handleCursorHook(payload, options);
    default:
      return handleAntigravityHook(payload, options);
  }
}
