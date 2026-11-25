#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getConfigPath,
  getDataDir,
  isDndActive,
  loadConfig,
  saveConfig,
  setDnd,
} from '../src/config.mjs';
import {
  clearHistory,
  formatDuration,
  getUnreadCount,
  markAllRead,
  readHistory,
} from '../src/store.mjs';
import { adaptHookEvent } from '../src/adapters/index.mjs';
import { inferTerminalFocusTarget, resolveProjectName } from '../src/adapters/antigravity.mjs';
import { dispatchNotification } from '../src/channels/index.mjs';
import { CLI_ENTRY, hasNativeMacPopup, MACOS_MENUBAR_BIN, PROJECT_ROOT } from '../src/channels/popup.mjs';
import { getHooksStatus, installHooks, uninstallHooks } from '../src/hooks-installer.mjs';
import { startUiServer } from '../src/ui/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.resolve(__dirname, '../src/worker.mjs');

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      flags._rest = argv.slice(i + 1);
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function readStdinSync() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function spawnDetachedWorker(event, options = {}) {
  const tmpFile = path.join(
    os.tmpdir(),
    `agent-notices-evt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify({ event, options }), 'utf8');
  const child = spawn(process.execPath, [WORKER_SCRIPT, '--event-file', tmpFile], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function setNestedValue(obj, dotKey, rawValue) {
  const keys = dotKey.split('.');
  let value = rawValue;
  if (rawValue === 'true') value = true;
  else if (rawValue === 'false') value = false;
  else if (rawValue === 'null') value = null;
  else if (rawValue !== '' && !Number.isNaN(Number(rawValue))) value = Number(rawValue);

  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function getNestedValue(obj, dotKey) {
  return dotKey.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

async function cmdHook(positionals, flags) {
  const agent = positionals[0] || 'auto';
  let rawJson = '';

  // Codex passes payload as final positional JSON argument
  const jsonPositional = positionals.slice(1).find((p) => p.trim().startsWith('{'));
  if (jsonPositional) {
    rawJson = jsonPositional;
  } else {
    rawJson = readStdinSync();
  }

  let payload = {};
  if (rawJson && rawJson.trim()) {
    try {
      payload = JSON.parse(rawJson);
    } catch {
      payload = {};
    }
  }

  const config = loadConfig();
  const { stdout, event } = adaptHookEvent(agent, payload, {
    eventOverride: typeof flags.event === 'string' ? flags.event : null,
    config,
  });

  const skipSubagent = Boolean(event?.isSubagent && config.policy?.ignoreSubagents !== false);
  const skipBgWait = Boolean(
    event?.waitingBackground &&
      event?.kind !== 'error' &&
      event?.kind !== 'attention' &&
      config.policy?.waitForFullyIdle !== false
  );
  const skipCanceled = Boolean(event?.canceled && config.policy?.ignoreUserCanceled !== false);

  if (event && !skipSubagent && !skipBgWait && !skipCanceled) {
    if (flags.sync) {
      await dispatchNotification(event, { config });
    } else {
      spawnDetachedWorker(event, {});
    }
  }

  // Emit exact protocol response to stdout immediately so sync hooks never block the agent
  process.stdout.write(JSON.stringify(stdout || {}) + '\n');
}

async function cmdSend(positionals, flags) {
  const title = flags.title || positionals[0] || '任务已完成';
  const message = flags.message || positionals[1] || '来自 AgentNotices 的手动提醒通知。';
  const kind = flags.kind || 'done';
  const cwd = flags.cwd || process.cwd();
  const project = flags.project || resolveProjectName(cwd);
  const agent = flags.agent || 'cli';
  const agentLabel = flags['agent-label'] || (agent === 'antigravity' ? 'Antigravity' : agent === 'claude' ? 'Claude Code' : 'CLI');
  const durationMs = flags.duration ? Number(flags.duration) * 1000 : null;

  const focusTarget =
    agent === 'antigravity'
      ? { appName: 'Antigravity', bundleId: 'com.google.antigravity', windowHint: project }
      : { ...inferTerminalFocusTarget(), windowHint: project };

  const popupOverrides = {};
  if (flags.style) popupOverrides.style = flags.style;
  if (flags.variant) popupOverrides.cardVariant = flags.variant;
  if (flags.position) popupOverrides.position = flags.position;
  if (flags.sticky) {
    popupOverrides.sticky = true;
    popupOverrides.durationSeconds = 0;
  }
  if (flags.seconds) {
    popupOverrides.durationSeconds = Number(flags.seconds);
    popupOverrides.sticky = Number(flags.seconds) <= 0;
  }

  const event = {
    id: `man_${crypto.randomBytes(6).toString('hex')}`,
    timestamp: new Date().toISOString(),
    agent,
    agentLabel,
    kind,
    title,
    message,
    project,
    cwd,
    conversationId: `manual-${Date.now()}`,
    durationMs,
    reason: 'manual',
    canceled: false,
    focusTarget,
  };

  const res = await dispatchNotification(event, {
    force: Boolean(flags.force !== 'false'),
    popupOverrides: Object.keys(popupOverrides).length ? popupOverrides : null,
  });

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(res.delivered ? `✓ 已触发提醒 [${res.tier}] (${event.project}: ${event.title})` : `已跳过提醒 (${res.reason})`);
  }
}

async function cmdTest(flags) {
  const style = flags.style || loadConfig().popup?.style || 'card';
  const kind = flags.kind || (style === 'modal' ? 'attention' : 'done');
  const titles = {
    done: '会话任务已完成',
    attention: '长任务等待你的确认',
    error: '构建测试出现失败',
    info: '状态更新通知',
  };
  const messages = {
    done: '已完成代码重构、补齐 18 项单元测试并编译通过，点击下方按钮可一键切回原工作窗口。',
    attention: 'Agent 已连续执行 1 分 42 秒并完成核心改动，请确认是否继续合并分支并推送远程。',
    error: '运行 npm test 时有 2 项用例未通过：policy.test.mjs 断言失败，点击切回排查。',
    info: 'AgentNotices 原生弹窗、声音与多通道配置运行正常。',
  };

  await cmdSend([], {
    title: flags.title || titles[kind] || titles.done,
    message: flags.message || messages[kind] || messages.done,
    kind,
    agent: flags.agent || 'antigravity',
    project: flags.project || resolveProjectName(process.cwd()),
    duration: flags.duration || '84',
    style,
    variant: flags.variant,
    position: flags.position,
    sticky: flags.sticky,
    seconds: flags.seconds || '8',
    force: true,
    json: flags.json,
  });
}

async function cmdRun(positionals, flags) {
  const cmdArgs = flags._rest && flags._rest.length ? flags._rest : positionals;
  if (cmdArgs.length === 0) {
    console.error('用法：agent-notices run -- <command> [args...]');
    process.exit(1);
  }
  const startedAt = Date.now();
  const res = spawnSync(cmdArgs[0], cmdArgs.slice(1), { stdio: 'inherit', shell: false });
  const durationMs = Date.now() - startedAt;
  const code = res.status ?? 1;
  const ok = code === 0;
  const cmdStr = cmdArgs.join(' ');
  const project = resolveProjectName(process.cwd());

  await dispatchNotification(
    {
      id: `run_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      agent: 'cli',
      agentLabel: 'CLI Task',
      kind: ok ? 'done' : 'error',
      title: ok ? '命令执行完成' : `命令执行失败 (exit ${code})`,
      message: `${cmdStr} · 耗时 ${formatDuration(durationMs)}`,
      project,
      cwd: process.cwd(),
      conversationId: `run-${startedAt}`,
      durationMs,
      reason: ok ? 'exit_0' : `exit_${code}`,
      canceled: false,
      focusTarget: { ...inferTerminalFocusTarget(), windowHint: project },
    },
    { force: Boolean(flags.force) }
  );

  process.exit(code);
}

function cmdInstall(positionals, flags) {
  const targets = positionals.length ? positionals : ['auto'];
  const results = installHooks(targets, { force: Boolean(flags.force) });
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ 已安装 ${r.agent} hook -> ${r.configPath}`);
    } else {
      console.error(`✕ 安装 ${r.agent} 失败：${r.error}`);
    }
  }
}

function cmdUninstall(positionals) {
  const targets = positionals.length ? positionals : ['all'];
  const results = uninstallHooks(targets);
  for (const r of results) {
    if (r.changed) {
      console.log(`✓ 已卸载 ${r.agent} hook (${r.configPath})`);
    } else {
      console.log(`- ${r.agent} 未安装或无需改动`);
    }
  }
}

function cmdStatus(flags) {
  const cfg = loadConfig();
  const dnd = isDndActive(cfg);
  const hooks = getHooksStatus();
  const unread = getUnreadCount();

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          configPath: getConfigPath(),
          dataDir: getDataDir(),
          nativePopupReady: hasNativeMacPopup(),
          menubarReady: fs.existsSync(MACOS_MENUBAR_BIN),
          dnd,
          unread,
          popupStyle: cfg.popup?.style,
          hooks,
        },
        null,
        2
      )
    );
    return;
  }

  console.log('AgentNotices 状态总览');
  console.log('────────────────────────────────────────');
  console.log(`配置文件：   ${getConfigPath()}`);
  console.log(`原生弹窗：   ${hasNativeMacPopup() ? '✓ macOS Swift AppKit 已编译' : '未编译（运行 npm run build:macos）'}`);
  console.log(`菜单栏助手： ${fs.existsSync(MACOS_MENUBAR_BIN) ? '✓ 已编译' : '未编译'}`);
  console.log(`提醒状态：   ${dnd.active ? `免打扰中 (${dnd.reason}${dnd.until ? ' 至 ' + dnd.until : ''})` : '✓ 正常运行中'}`);
  console.log(`默认弹窗：   ${cfg.popup?.style} / 卡片外观 ${cfg.popup?.cardVariant || 'pill'} (${cfg.popup?.position}) · 升级弹窗：${cfg.popup?.escalatedStyle}`);
  console.log(`未读提醒：   ${unread} 条`);
  console.log('');
  console.log('Agent Hooks 集成状态：');
  for (const [key, info] of Object.entries(hooks)) {
    const det = info.detected ? '已检测到工具' : '未检测到';
    const inst = info.installed ? '✓ 已接入' : '未接入';
    console.log(`  - ${info.name.padEnd(13)} ${inst.padEnd(8)} (${det}) -> ${info.configPath}`);
  }
}

function cmdDnd(positionals, flags) {
  const sub = positionals[0];
  if (sub === 'off' || sub === 'resume') {
    setDnd({ enabled: false });
    console.log('✓ 已关闭免打扰，恢复正常提醒。');
    return;
  }
  if (flags.minutes) {
    const mins = Number(flags.minutes);
    const cfg = setDnd({ enabled: true, minutes: mins });
    console.log(`✓ 已静音 ${mins} 分钟（至 ${new Date(cfg.dndUntil).toLocaleTimeString()}）。`);
    return;
  }
  if (sub === 'on' || !sub) {
    setDnd({ enabled: true });
    console.log('✓ 已开启全局免打扰（运行 agent-notices dnd off 恢复）。');
    return;
  }
  console.error('用法：agent-notices dnd [on|off|--minutes 30]');
}

function cmdConfig(positionals) {
  const action = positionals[0] || 'show';
  if (action === 'show') {
    console.log(JSON.stringify(loadConfig(), null, 2));
    return;
  }
  if (action === 'get' && positionals[1]) {
    console.log(JSON.stringify(getNestedValue(loadConfig(), positionals[1]), null, 2));
    return;
  }
  if (action === 'set' && positionals[1] && positionals[2] !== undefined) {
    const patch = setNestedValue({}, positionals[1], positionals[2]);
    saveConfig(patch, { merge: true });
    console.log(`✓ 已更新配置 ${positionals[1]} = ${positionals[2]}`);
    return;
  }
  if (action === 'path') {
    console.log(getConfigPath());
    return;
  }
  console.error('用法：agent-notices config [show | path | get <key> | set <key> <value>]');
}

function cmdHistory(positionals, flags) {
  const sub = positionals[0];
  if (sub === 'read-all') {
    markAllRead();
    console.log('✓ 已全部标为已读。');
    return;
  }
  if (sub === 'clear') {
    clearHistory();
    console.log('✓ 已清空通知历史。');
    return;
  }
  const limit = Number(flags.limit || 20);
  const items = readHistory({ limit, agent: flags.agent || null, kind: flags.kind || null });
  if (flags.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log('暂无通知历史记录。');
    return;
  }
  for (const it of items) {
    const icon = it.kind === 'error' ? '✕' : it.kind === 'attention' ? '⚠' : '✓';
    const dur = formatDuration(it.durationMs);
    const time = new Date(it.timestamp).toLocaleTimeString();
    console.log(`${icon} [${time}] [${it.agentLabel || it.agent}] ${it.project} · ${it.title}${dur ? ` (${dur})` : ''}`);
    if (it.message) console.log(`    ${it.message}`);
  }
}

function cmdMenubar(flags) {
  if (process.platform !== 'darwin') {
    console.error('原生菜单栏助手目前仅支持 macOS。');
    process.exit(1);
  }
  if (!fs.existsSync(MACOS_MENUBAR_BIN)) {
    console.log('首次启动正在编译 macOS 原生菜单栏助手...');
    const r = spawnSync('bash', [path.join(PROJECT_ROOT, 'src', 'native', 'macos', 'build.sh')], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
  const args = ['--cli', CLI_ENTRY, '--node', process.execPath, '--data-dir', getDataDir()];
  if (flags.foreground) {
    spawnSync(MACOS_MENUBAR_BIN, args, { stdio: 'inherit' });
  } else {
    const child = spawn(MACOS_MENUBAR_BIN, args, { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('✓ AgentNotices 菜单栏常驻助手已启动（可在屏幕顶部菜单栏查看铃铛图标）。');
  }
}

function cmdBuild() {
  const r = spawnSync('bash', [path.join(PROJECT_ROOT, 'src', 'native', 'macos', 'build.sh')], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

function printHelp() {
  console.log(`
AgentNotices — AI 会话任务完成多模态提醒工具
支持 Antigravity · Claude Code · Codex CLI · Cursor · 任意长命令

用法：
  agent-notices install [auto|all|antigravity|claude|codex|cursor]   一键安全接入 Hooks
  agent-notices uninstall [all|antigravity|claude|codex|cursor]      安全卸载 Hooks
  agent-notices status [--json]                                      查看配置与接入状态
  agent-notices test [--style card|modal|banner] [--variant pill|glass] [--kind done|attention|error] [--sticky]
                                                                     发送测试弹窗/音效/通道提醒
  agent-notices send --title "标题" --message "内容" [--style modal] 手动触发自定义提醒
  agent-notices run -- <command> [args...]                           包装任意长耗时命令，结束自动提醒
  agent-notices dnd [on|off|--minutes 30]                            免打扰 / 临时静音控制
  agent-notices menubar                                              启动 macOS 原生菜单栏常驻助手
  agent-notices ui [--port 47890] [--open]                           启动本地 Web 配置与通知控制台
  agent-notices history [read-all|clear] [--limit 20]                查看/管理通知历史
  agent-notices config [show|path|get <k>|set <k> <v>]               查看或修改配置
  agent-notices build                                                编译 macOS 原生 Swift 弹窗与菜单栏
  agent-notices hook <agent> [--event <EventName>]                   供各 AI 工具 Hook 自动调用
`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];
  const rest = positionals.slice(1);

  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'hook':
      await cmdHook(rest, flags);
      break;
    case 'send':
      await cmdSend(rest, flags);
      break;
    case 'test':
      await cmdTest(flags);
      break;
    case 'run':
      await cmdRun(rest, flags);
      break;
    case 'install':
      cmdInstall(rest, flags);
      break;
    case 'uninstall':
      cmdUninstall(rest);
      break;
    case 'status':
      cmdStatus(flags);
      break;
    case 'dnd':
      cmdDnd(rest, flags);
      break;
    case 'config':
      cmdConfig(rest);
      break;
    case 'history':
      cmdHistory(rest, flags);
      break;
    case 'menubar':
      cmdMenubar(flags);
      break;
    case 'ui': {
      const cfg = loadConfig();
      const port = Number(flags.port || cfg.ui?.port || 47890);
      await startUiServer({ port, openBrowser: Boolean(flags.open) });
      break;
    }
    case 'build':
      cmdBuild();
      break;
    default:
      console.error(`未知命令：${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
