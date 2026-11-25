import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  enabled: true,
  dnd: false,
  dndUntil: null,
  quietHours: {
    enabled: false,
    start: '23:00',
    end: '08:00',
  },
  policy: {
    minDurationSeconds: 5,
    escalateDurationSeconds: 30,
    ignoreUserCanceled: true,
    // "never" | "downgrade" | "suppress"
    whenTargetFocused: 'never',
    dedupeWindowMs: 3000,
  },
  popup: {
    enabled: true,
    // "card" | "modal" | "banner"
    style: 'card',
    // "pill" (compact dynamic pill, default) | "glass" (Apple liquid glass)
    cardVariant: 'pill',
    // Keep escalated alerts sliding from the right as cards by default; users can opt into "modal"
    escalatedStyle: 'card',
    // "top-right" | "bottom-right" | "top-center" | "center"
    position: 'top-right',
    durationSeconds: 10,
    stickyOnAttention: true,
    stickyOnEscalated: false,
    showFocusButton: true,
    showMuteButton: true,
    // "auto" | "dark" | "light"
    theme: 'auto',
  },
  systemNotification: {
    enabled: false,
  },
  sound: {
    enabled: true,
    volume: 0.85,
    done: 'Glass',
    attention: 'Ping',
    error: 'Basso',
    info: 'Pop',
  },
  tts: {
    enabled: false,
    voice: '',
    rate: 195,
    template: '{project}，{title}',
  },
  summary: {
    readTranscript: true,
    maxLength: 220,
    llm: {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      timeoutMs: 4000,
    },
  },
  webhooks: {
    feishu: { enabled: false, url: '', secret: '' },
    dingtalk: { enabled: false, url: '', secret: '' },
    wecom: { enabled: false, url: '' },
    bark: {
      enabled: false,
      serverUrl: 'https://api.day.app',
      deviceKey: '',
      sound: 'bell',
      level: 'timeSensitive',
      group: 'AgentNotices',
    },
    telegram: { enabled: false, botToken: '', chatId: '' },
    ntfy: { enabled: false, url: 'https://ntfy.sh', topic: '', token: '' },
    custom: { enabled: false, url: '', method: 'POST', headers: {} },
  },
  ui: {
    port: 47890,
  },
};

export function getDataDir() {
  if (process.env.AGENT_NOTICES_HOME) {
    return path.resolve(process.env.AGENT_NOTICES_HOME);
  }
  return path.join(os.homedir(), '.config', 'agent-notices');
}

export function getConfigPath() {
  return path.join(getDataDir(), 'config.json');
}

export function ensureDataDir() {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function deepMerge(base, override) {
  if (override === null || override === undefined) {
    return structuredClone(base);
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return structuredClone(override);
  }
  if (typeof override !== 'object' || Array.isArray(override)) {
    return structuredClone(override);
  }
  const result = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const key of keys) {
    if (key in override) {
      if (key in base && isPlainObject(base[key]) && isPlainObject(override[key])) {
        result[key] = deepMerge(base[key], override[key]);
      } else {
        result[key] = structuredClone(override[key]);
      }
    } else {
      result[key] = structuredClone(base[key]);
    }
  }
  return result;
}

function isPlainObject(val) {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(partialOrFull, { merge = true } = {}) {
  ensureDataDir();
  const next = merge ? deepMerge(loadConfig(), partialOrFull) : deepMerge(DEFAULT_CONFIG, partialOrFull);
  const configPath = getConfigPath();
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, configPath);
  return next;
}

export function setDnd({ enabled = true, minutes = null } = {}) {
  if (!enabled) {
    return saveConfig({ dnd: false, dndUntil: null });
  }
  if (typeof minutes === 'number' && minutes > 0) {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    return saveConfig({ dnd: false, dndUntil: until });
  }
  return saveConfig({ dnd: true, dndUntil: null });
}

export function isDndActive(config, now = new Date()) {
  if (!config.enabled) return { active: true, reason: 'disabled' };
  if (config.dnd) return { active: true, reason: 'dnd' };
  if (config.dndUntil) {
    const untilTs = Date.parse(config.dndUntil);
    if (!Number.isNaN(untilTs) && now.getTime() < untilTs) {
      return { active: true, reason: 'dnd_until', until: config.dndUntil };
    }
  }
  if (config.quietHours?.enabled) {
    if (isWithinQuietHours(config.quietHours.start, config.quietHours.end, now)) {
      return { active: true, reason: 'quiet_hours' };
    }
  }
  return { active: false, reason: null };
}

export function isWithinQuietHours(startStr = '23:00', endStr = '08:00', now = new Date()) {
  const startMin = parseHHMM(startStr);
  const endMin = parseHHMM(endStr);
  if (startMin === null || endMin === null) return false;
  const curMin = now.getHours() * 60 + now.getMinutes();
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return curMin >= startMin && curMin < endMin;
  }
  // Spans midnight, e.g. 23:00 -> 08:00
  return curMin >= startMin || curMin < endMin;
}

function parseHHMM(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
