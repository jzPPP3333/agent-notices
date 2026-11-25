import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_ENTRY } from './channels/popup.mjs';

const HOOK_MARKER = 'agent-notices';

function quoteArg(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

function buildHookCommand(agent, extraArgs = '', { nodePath = process.execPath, cliPath = CLI_ENTRY } = {}) {
  const suffix = extraArgs ? ` ${extraArgs}` : '';
  return `${quoteArg(nodePath)} ${quoteArg(cliPath)} hook ${agent}${suffix}`;
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const bakPath = `${filePath}.agent-notices.bak`;
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(filePath, bakPath);
  }
  return bakPath;
}

function readJsonSafe(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return structuredClone(fallback);
  return JSON.parse(raw);
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export function getAgentPaths(homeDir = os.homedir()) {
  return {
    antigravity: {
      name: 'Antigravity',
      detectDir: path.join(homeDir, '.gemini'),
      configPath: path.join(homeDir, '.gemini', 'config', 'hooks.json'),
    },
    claude: {
      name: 'Claude Code',
      detectDir: path.join(homeDir, '.claude'),
      configPath: path.join(homeDir, '.claude', 'settings.json'),
    },
    codex: {
      name: 'Codex CLI',
      detectDir: path.join(homeDir, '.codex'),
      configPath: path.join(homeDir, '.codex', 'config.toml'),
    },
    cursor: {
      name: 'Cursor',
      detectDir: path.join(homeDir, '.cursor'),
      configPath: path.join(homeDir, '.cursor', 'hooks.json'),
    },
  };
}

// ---------- Antigravity (~/.gemini/config/hooks.json) ----------

function isAntigravityInstalled(configPath) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const json = readJsonSafe(configPath, {});
    return Boolean(json && json[HOOK_MARKER] && json[HOOK_MARKER].enabled !== false);
  } catch {
    return false;
  }
}

function installAntigravity(configPath, opts) {
  backupFile(configPath);
  const json = readJsonSafe(configPath, {});
  json[HOOK_MARKER] = {
    enabled: true,
    PreInvocation: [
      {
        type: 'command',
        command: buildHookCommand('antigravity', '--event PreInvocation', opts),
        timeout: 5,
      },
    ],
    Stop: [
      {
        type: 'command',
        command: buildHookCommand('antigravity', '--event Stop', opts),
        timeout: 10,
      },
    ],
  };
  writeJsonAtomic(configPath, json);
  return { ok: true, agent: 'antigravity', configPath };
}

function uninstallAntigravity(configPath) {
  if (!fs.existsSync(configPath)) return { ok: true, agent: 'antigravity', changed: false };
  const json = readJsonSafe(configPath, {});
  if (!(HOOK_MARKER in json)) return { ok: true, agent: 'antigravity', changed: false };
  delete json[HOOK_MARKER];
  writeJsonAtomic(configPath, json);
  return { ok: true, agent: 'antigravity', changed: true, configPath };
}

// ---------- Claude Code (~/.claude/settings.json) ----------

function isClaudeHookEntryOurs(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.command === 'string' && entry.command.includes(HOOK_MARKER)) return true;
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));
  }
  return false;
}

function isClaudeInstalled(configPath) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const json = readJsonSafe(configPath, {});
    const stop = json?.hooks?.Stop;
    return Array.isArray(stop) && stop.some(isClaudeHookEntryOurs);
  } catch {
    return false;
  }
}

function installClaude(configPath, opts) {
  backupFile(configPath);
  const json = readJsonSafe(configPath, {});
  if (!json.hooks || typeof json.hooks !== 'object') json.hooks = {};

  const events = [
    { key: 'UserPromptSubmit', includeMatcher: false, cmd: buildHookCommand('claude', '--event UserPromptSubmit', opts), timeout: 5 },
    { key: 'Stop', includeMatcher: false, cmd: buildHookCommand('claude', '--event Stop', opts), timeout: 10 },
    { key: 'Notification', includeMatcher: true, matcher: '', cmd: buildHookCommand('claude', '--event Notification', opts), timeout: 10 },
  ];

  for (const ev of events) {
    const existing = Array.isArray(json.hooks[ev.key]) ? json.hooks[ev.key] : [];
    const filtered = existing.filter((item) => !isClaudeHookEntryOurs(item));
    const entry = {
      hooks: [
        {
          type: 'command',
          command: ev.cmd,
          timeout: ev.timeout,
        },
      ],
    };
    if (ev.includeMatcher) {
      entry.matcher = ev.matcher;
    }
    filtered.push(entry);
    json.hooks[ev.key] = filtered;
  }

  writeJsonAtomic(configPath, json);
  return { ok: true, agent: 'claude', configPath };
}

function uninstallClaude(configPath) {
  if (!fs.existsSync(configPath)) return { ok: true, agent: 'claude', changed: false };
  const json = readJsonSafe(configPath, {});
  if (!json.hooks || typeof json.hooks !== 'object') return { ok: true, agent: 'claude', changed: false };

  let changed = false;
  for (const key of ['UserPromptSubmit', 'Stop', 'Notification']) {
    if (!Array.isArray(json.hooks[key])) continue;
    const before = json.hooks[key].length;
    json.hooks[key] = json.hooks[key].filter((item) => !isClaudeHookEntryOurs(item));
    if (json.hooks[key].length !== before) changed = true;
    if (json.hooks[key].length === 0) delete json.hooks[key];
  }
  if (changed) writeJsonAtomic(configPath, json);
  return { ok: true, agent: 'claude', changed, configPath };
}

// ---------- Codex CLI (~/.codex/config.toml) ----------

function isCodexInstalled(configPath) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return /^\s*notify\s*=.*agent-notices/m.test(raw);
  } catch {
    return false;
  }
}

function installCodex(configPath, opts = {}) {
  backupFile(configPath);
  const nodePath = opts.nodePath || process.execPath;
  const cliPath = opts.cliPath || CLI_ENTRY;
  const notifyLine = `notify = [${JSON.stringify(nodePath)}, ${JSON.stringify(cliPath)}, "hook", "codex"]`;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';

  const notifyRegex = /^\s*notify\s*=\s*\[[^\]]*\]\s*$/m;
  if (notifyRegex.test(content)) {
    if (content.match(notifyRegex)[0].includes(HOOK_MARKER) || opts.force) {
      content = content.replace(notifyRegex, notifyLine);
    } else {
      return {
        ok: false,
        agent: 'codex',
        error: 'Codex config.toml already has a custom notify hook; pass --force to replace it.',
        configPath,
      };
    }
  } else {
    // Insert at top level before first [table] section so it belongs to root table
    const firstSectionIdx = content.search(/^\s*\[/m);
    if (firstSectionIdx === -1) {
      content = (content.trimEnd() ? content.trimEnd() + '\n' : '') + notifyLine + '\n';
    } else {
      const before = content.slice(0, firstSectionIdx).trimEnd();
      const after = content.slice(firstSectionIdx);
      content = (before ? before + '\n' : '') + notifyLine + '\n\n' + after;
    }
  }

  fs.writeFileSync(configPath, content, 'utf8');
  return { ok: true, agent: 'codex', configPath };
}

function uninstallCodex(configPath) {
  if (!fs.existsSync(configPath)) return { ok: true, agent: 'codex', changed: false };
  const raw = fs.readFileSync(configPath, 'utf8');
  const next = raw.replace(/^\s*notify\s*=.*agent-notices.*\r?\n?/m, '');
  if (next === raw) return { ok: true, agent: 'codex', changed: false };
  fs.writeFileSync(configPath, next, 'utf8');
  return { ok: true, agent: 'codex', changed: true, configPath };
}

// ---------- Cursor (~/.cursor/hooks.json) ----------

function isCursorInstalled(configPath) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const json = readJsonSafe(configPath, {});
    const stop = json?.hooks?.stop;
    return Array.isArray(stop) && stop.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));
  } catch {
    return false;
  }
}

function installCursor(configPath, opts) {
  backupFile(configPath);
  const json = readJsonSafe(configPath, { version: 1, hooks: {} });
  if (!json.version) json.version = 1;
  if (!json.hooks || typeof json.hooks !== 'object') json.hooks = {};

  const specs = [
    { key: 'beforeSubmitPrompt', cmd: buildHookCommand('cursor', '--event beforeSubmitPrompt', opts) },
    { key: 'stop', cmd: buildHookCommand('cursor', '--event stop', opts) },
  ];

  for (const s of specs) {
    const arr = Array.isArray(json.hooks[s.key]) ? json.hooks[s.key] : [];
    const filtered = arr.filter((h) => !(typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)));
    filtered.push({ command: s.cmd });
    json.hooks[s.key] = filtered;
  }

  writeJsonAtomic(configPath, json);
  return { ok: true, agent: 'cursor', configPath };
}

function uninstallCursor(configPath) {
  if (!fs.existsSync(configPath)) return { ok: true, agent: 'cursor', changed: false };
  const json = readJsonSafe(configPath, {});
  if (!json.hooks) return { ok: true, agent: 'cursor', changed: false };
  let changed = false;
  for (const key of ['beforeSubmitPrompt', 'stop']) {
    if (!Array.isArray(json.hooks[key])) continue;
    const before = json.hooks[key].length;
    json.hooks[key] = json.hooks[key].filter((h) => !(typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)));
    if (json.hooks[key].length !== before) changed = true;
    if (json.hooks[key].length === 0) delete json.hooks[key];
  }
  if (changed) writeJsonAtomic(configPath, json);
  return { ok: true, agent: 'cursor', changed, configPath };
}

// ---------- Public API ----------

export function getHooksStatus({ homeDir = os.homedir() } = {}) {
  const paths = getAgentPaths(homeDir);
  return {
    antigravity: {
      name: paths.antigravity.name,
      detected: fs.existsSync(paths.antigravity.detectDir),
      installed: isAntigravityInstalled(paths.antigravity.configPath),
      configPath: paths.antigravity.configPath,
    },
    claude: {
      name: paths.claude.name,
      detected: fs.existsSync(paths.claude.detectDir),
      installed: isClaudeInstalled(paths.claude.configPath),
      configPath: paths.claude.configPath,
    },
    codex: {
      name: paths.codex.name,
      detected: fs.existsSync(paths.codex.detectDir),
      installed: isCodexInstalled(paths.codex.configPath),
      configPath: paths.codex.configPath,
    },
    cursor: {
      name: paths.cursor.name,
      detected: fs.existsSync(paths.cursor.detectDir),
      installed: isCursorInstalled(paths.cursor.configPath),
      configPath: paths.cursor.configPath,
    },
  };
}

export function installHooks(targets = ['auto'], opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const paths = getAgentPaths(homeDir);
  const status = getHooksStatus({ homeDir });

  let resolved = targets;
  if (!targets || targets.length === 0 || targets.includes('auto')) {
    resolved = Object.entries(status)
      .filter(([, info]) => info.detected)
      .map(([k]) => k);
    if (resolved.length === 0) resolved = ['antigravity'];
  } else if (targets.includes('all')) {
    resolved = ['antigravity', 'claude', 'codex', 'cursor'];
  }

  const results = [];
  for (const agent of resolved) {
    switch (agent) {
      case 'antigravity':
      case 'agy':
        results.push(installAntigravity(paths.antigravity.configPath, opts));
        break;
      case 'claude':
      case 'claude-code':
        results.push(installClaude(paths.claude.configPath, opts));
        break;
      case 'codex':
        results.push(installCodex(paths.codex.configPath, opts));
        break;
      case 'cursor':
        results.push(installCursor(paths.cursor.configPath, opts));
        break;
      default:
        results.push({ ok: false, agent, error: `Unknown agent: ${agent}` });
    }
  }
  return results;
}

export function uninstallHooks(targets = ['all'], opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const paths = getAgentPaths(homeDir);
  const resolved = !targets || targets.length === 0 || targets.includes('all')
    ? ['antigravity', 'claude', 'codex', 'cursor']
    : targets;

  const results = [];
  for (const agent of resolved) {
    switch (agent) {
      case 'antigravity':
      case 'agy':
        results.push(uninstallAntigravity(paths.antigravity.configPath));
        break;
      case 'claude':
      case 'claude-code':
        results.push(uninstallClaude(paths.claude.configPath));
        break;
      case 'codex':
        results.push(uninstallCodex(paths.codex.configPath));
        break;
      case 'cursor':
        results.push(uninstallCursor(paths.cursor.configPath));
        break;
      default:
        results.push({ ok: false, agent, error: `Unknown agent: ${agent}` });
    }
  }
  return results;
}
