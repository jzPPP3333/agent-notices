import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDir, getDataDir } from './config.mjs';

const MAX_HISTORY_LINES = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function getStatePath() {
  return path.join(getDataDir(), 'state.json');
}

export function getHistoryPath() {
  return path.join(getDataDir(), 'history.jsonl');
}

function readState() {
  const p = getStatePath();
  if (!fs.existsSync(p)) {
    return { sessions: {}, dedupe: {}, unreadCount: 0 };
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      sessions: data.sessions || {},
      dedupe: data.dedupe || {},
      unreadCount: Number(data.unreadCount || 0),
    };
  } catch {
    return { sessions: {}, dedupe: {}, unreadCount: 0 };
  }
}

function writeState(state) {
  ensureDataDir();
  const p = getStatePath();
  const tmp = `${p}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function pruneOldEntries(map, ttlMs, nowMs) {
  for (const [k, v] of Object.entries(map)) {
    const ts = typeof v === 'number' ? v : v?.updatedAt || v?.startedAt || 0;
    if (nowMs - ts > ttlMs) {
      delete map[k];
    }
  }
}

/**
 * Record the start of a conversation turn so completion can calculate elapsed time accurately.
 */
export function markTurnStart(sessionKey, { reset = false, metadata = {} } = {}, nowMs = Date.now()) {
  if (!sessionKey) return;
  const state = readState();
  pruneOldEntries(state.sessions, SESSION_TTL_MS, nowMs);
  const existing = state.sessions[sessionKey];
  if (reset || !existing || !existing.startedAt) {
    state.sessions[sessionKey] = {
      startedAt: nowMs,
      updatedAt: nowMs,
      ...metadata,
    };
  } else {
    state.sessions[sessionKey] = {
      ...existing,
      ...metadata,
      updatedAt: nowMs,
    };
  }
  writeState(state);
}

/**
 * Consume the recorded turn start time and return elapsed duration in ms (or null).
 */
export function consumeTurnDuration(sessionKey, nowMs = Date.now()) {
  if (!sessionKey) return null;
  const state = readState();
  const rec = state.sessions[sessionKey];
  if (!rec || !rec.startedAt) return null;
  const durationMs = Math.max(0, nowMs - rec.startedAt);
  delete state.sessions[sessionKey];
  writeState(state);
  return durationMs;
}

/**
 * Returns true if the same dedupe key was seen within windowMs.
 */
export function checkAndRecordDedupe(dedupeKey, windowMs = 3000, nowMs = Date.now()) {
  if (!dedupeKey || windowMs <= 0) return false;
  const state = readState();
  pruneOldEntries(state.dedupe, Math.max(windowMs * 4, 60_000), nowMs);
  const last = state.dedupe[dedupeKey];
  if (typeof last === 'number' && nowMs - last < windowMs) {
    return true;
  }
  state.dedupe[dedupeKey] = nowMs;
  writeState(state);
  return false;
}

export function appendHistory(entry) {
  ensureDataDir();
  const historyPath = getHistoryPath();
  const record = {
    ...entry,
    read: false,
  };
  fs.appendFileSync(historyPath, JSON.stringify(record) + '\n', 'utf8');

  // Trim if history grows beyond limit
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > MAX_HISTORY_LINES) {
      const trimmed = lines.slice(-MAX_HISTORY_LINES).join('\n') + '\n';
      fs.writeFileSync(historyPath, trimmed, 'utf8');
    }
  } catch {
    // Non-fatal
  }

  const state = readState();
  state.unreadCount = Number(state.unreadCount || 0) + 1;
  writeState(state);
  return record;
}

export function readHistory({ limit = 50, agent = null, kind = null } = {}) {
  const historyPath = getHistoryPath();
  if (!fs.existsSync(historyPath)) return [];
  try {
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    const items = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (agent && obj.agent !== agent) continue;
        if (kind && obj.kind !== kind) continue;
        items.push(obj);
        if (items.length >= limit) break;
      } catch {
        // skip malformed line
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function getUnreadCount() {
  return readState().unreadCount || 0;
}

export function markAllRead() {
  const state = readState();
  state.unreadCount = 0;
  writeState(state);

  const historyPath = getHistoryPath();
  if (fs.existsSync(historyPath)) {
    try {
      const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
      const updated = lines.map((line) => {
        try {
          const obj = JSON.parse(line);
          obj.read = true;
          return JSON.stringify(obj);
        } catch {
          return line;
        }
      });
      fs.writeFileSync(historyPath, updated.join('\n') + (updated.length ? '\n' : ''), 'utf8');
    } catch {
      // ignore
    }
  }
  return 0;
}

export function clearHistory() {
  const historyPath = getHistoryPath();
  if (fs.existsSync(historyPath)) {
    fs.writeFileSync(historyPath, '', 'utf8');
  }
  const state = readState();
  state.unreadCount = 0;
  writeState(state);
}

export function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined || Number.isNaN(durationMs)) {
    return '';
  }
  const totalSec = Math.max(0, Math.round(durationMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}
