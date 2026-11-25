import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notices-test-'));
process.env.AGENT_NOTICES_HOME = path.join(tmpRoot, 'data');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../bin/agent-notices.mjs');

const { DEFAULT_CONFIG, isDndActive, isWithinQuietHours, loadConfig, saveConfig, setDnd } = await import('../src/config.mjs');
const { appendHistory, checkAndRecordDedupe, clearHistory, consumeTurnDuration, formatDuration, getUnreadCount, markAllRead, markTurnStart, readHistory } = await import('../src/store.mjs');
const { cleanText, extractLastAssistantText } = await import('../src/summary.mjs');
const { evaluatePolicy } = await import('../src/policy.mjs');
const { adaptHookEvent } = await import('../src/adapters/index.mjs');
const { buildDingTalkRequest, buildFeishuPayload, buildWeComPayload } = await import('../src/channels/webhook.mjs');
const { getHooksStatus, installHooks, uninstallHooks } = await import('../src/hooks-installer.mjs');
const { createUiServer } = await import('../src/ui/server.mjs');

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('config save, deep merge, DND, and cross-midnight quiet hours', () => {
  const initial = loadConfig();
  assert.equal(initial.popup.style, 'card');

  saveConfig({ popup: { style: 'modal' } });
  const updated = loadConfig();
  assert.equal(updated.popup.style, 'modal');
  assert.equal(updated.popup.position, DEFAULT_CONFIG.popup.position);

  setDnd({ enabled: true, minutes: 30 });
  assert.equal(isDndActive(loadConfig()).active, true);
  assert.equal(isDndActive(loadConfig()).reason, 'dnd_until');

  setDnd({ enabled: false });
  assert.equal(isDndActive(loadConfig()).active, false);

  assert.equal(isWithinQuietHours('23:00', '08:00', new Date(2026, 10, 25, 23, 30)), true);
  assert.equal(isWithinQuietHours('23:00', '08:00', new Date(2026, 10, 25, 2, 15)), true);
  assert.equal(isWithinQuietHours('23:00', '08:00', new Date(2026, 10, 25, 14, 0)), false);
});

test('store turn duration, dedupe, and history unread tracking', () => {
  markTurnStart('agy:conv-1', { reset: true }, 1000);
  markTurnStart('agy:conv-1', { reset: false }, 5000);
  const dur = consumeTurnDuration('agy:conv-1', 46_000);
  assert.equal(dur, 45_000);
  assert.equal(consumeTurnDuration('agy:conv-1', 50_000), null);
  assert.equal(formatDuration(84_000), '1m 24s');

  assert.equal(checkAndRecordDedupe('k1', 3000, 10_000), false);
  assert.equal(checkAndRecordDedupe('k1', 3000, 11_000), true);
  assert.equal(checkAndRecordDedupe('k1', 3000, 14_000), false);

  clearHistory();
  appendHistory({ id: 'h1', agent: 'antigravity', kind: 'done', title: 'Done 1', project: 'notices' });
  appendHistory({ id: 'h2', agent: 'claude', kind: 'error', title: 'Err 2', project: 'app' });
  assert.equal(getUnreadCount(), 2);
  assert.equal(readHistory({ limit: 10 }).length, 2);
  assert.equal(readHistory({ agent: 'claude' }).length, 1);

  markAllRead();
  assert.equal(getUnreadCount(), 0);
});

test('transcript tail extraction supports Antigravity and Claude Code formats', () => {
  const agyTranscript = path.join(tmpRoot, 'agy.jsonl');
  fs.writeFileSync(
    agyTranscript,
    [
      JSON.stringify({ type: 'USER_INPUT', content: '重构弹窗模块' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: '## 完成\n已重构 `NoticesPopup.swift` 并通过全部测试。' }),
    ].join('\n') + '\n',
    'utf8'
  );
  const agyText = extractLastAssistantText(agyTranscript);
  assert.match(agyText, /已重构/);
  assert.equal(cleanText(agyText, 80), '完成 已重构 NoticesPopup.swift 并通过全部测试。');
  assert.equal(cleanText('第一段\n\n第二段', 80), '第一段 · 第二段');

  const claudeTranscript = path.join(tmpRoot, 'claude.jsonl');
  fs.writeFileSync(
    claudeTranscript,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'All 12 unit tests passed.' }] },
    }) + '\n',
    'utf8'
  );
  assert.equal(extractLastAssistantText(claudeTranscript), 'All 12 unit tests passed.');
});

test('adapters parse Antigravity, Claude Code, Codex, and Cursor payloads', () => {
  // Antigravity PreInvocation -> Stop
  const pre = adaptHookEvent('antigravity', {
    hookEventName: 'PreInvocation',
    conversationId: 'c-agy-1',
    invocationNum: 1,
    workspacePaths: ['/Users/dev/demo-app'],
  });
  assert.deepEqual(pre.stdout, {});
  assert.equal(pre.event, null);

  const stop = adaptHookEvent('antigravity', {
    hookEventName: 'Stop',
    conversationId: 'c-agy-1',
    workspacePaths: ['/Users/dev/demo-app'],
    terminationReason: 'NO_TOOL_CALL',
    lastUserInput: 'Fix auth bug',
    fullyIdle: true,
  });
  assert.deepEqual(stop.stdout, { decision: 'stop' });
  assert.equal(stop.event.agent, 'antigravity');
  assert.equal(stop.event.project, 'demo-app');
  assert.equal(stop.event.kind, 'done');
  assert.equal(stop.event.focusTarget.bundleId, 'com.google.antigravity');

  // Antigravity ERROR & USER_CANCELED
  const errStop = adaptHookEvent('antigravity', {
    hookEventName: 'Stop',
    conversationId: 'c-agy-err',
    terminationReason: 'ERROR',
    error: 'Network timeout',
  });
  assert.equal(errStop.event.kind, 'error');
  assert.equal(errStop.event.errorText, 'Network timeout');

  const cancelStop = adaptHookEvent('antigravity', {
    hookEventName: 'Stop',
    conversationId: 'c-agy-cancel',
    terminationReason: 'USER_CANCELED',
  });
  assert.equal(cancelStop.event.canceled, true);

  // Claude Code Notification & stop_hook_active recursion guard
  const ccPerm = adaptHookEvent('claude', {
    hook_event_name: 'Notification',
    session_id: 's1',
    cwd: '/tmp/my-repo',
    notification_type: 'permission_prompt',
    message: 'Run rm -rf build?',
  });
  assert.equal(ccPerm.event.kind, 'attention');
  assert.equal(ccPerm.event.title, '等待授权审批');

  const ccLoop = adaptHookEvent('claude', {
    hook_event_name: 'Stop',
    session_id: 's1',
    stop_hook_active: true,
  });
  assert.equal(ccLoop.event, null);

  // Codex CLI
  const codex = adaptHookEvent('codex', {
    type: 'agent-turn-complete',
    'thread-id': 'th-1',
    cwd: '/Users/dev/backend',
    'input-messages': ['Add API pagination'],
    'last-assistant-message': 'Added cursor pagination.',
  });
  assert.equal(codex.event.agent, 'codex');
  assert.equal(codex.event.project, 'backend');
  assert.equal(codex.event.assistantText, 'Added cursor pagination.');

  // Cursor
  const cursor = adaptHookEvent('cursor', {
    hook_event_name: 'stop',
    conversation_id: 'cur-1',
    workspace_roots: ['/Users/dev/web'],
    status: 'completed',
    text: 'Refactored navbar.',
  });
  assert.equal(cursor.event.agent, 'cursor');
  assert.equal(cursor.event.focusTarget.appName, 'Cursor');
});

test('policy engine handles thresholds, escalation, sticky urgent, focus downgrade, and cancel', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);

  // Short normal task -> silent
  const pShort = evaluatePolicy({ kind: 'done', durationMs: 2000, canceled: false }, cfg);
  assert.equal(pShort.shouldNotify, false);
  assert.equal(pShort.reason, 'below_min_duration');

  // Short error task -> bypasses threshold and escalates with sticky
  const pErr = evaluatePolicy({ kind: 'error', durationMs: 1000, canceled: false }, cfg);
  assert.equal(pErr.shouldNotify, true);
  assert.equal(pErr.tier, 'escalated');
  assert.equal(pErr.channels.popup.style, 'modal');
  assert.equal(pErr.channels.popup.sticky, true);

  // Medium task -> normal card (default pill variant)
  const pMed = evaluatePolicy({ kind: 'done', durationMs: 15_000, canceled: false }, cfg);
  assert.equal(pMed.shouldNotify, true);
  assert.equal(pMed.tier, 'normal');
  assert.equal(pMed.channels.popup.style, 'card');
  assert.equal(pMed.channels.popup.cardVariant, 'pill');
  assert.equal(pMed.channels.popup.sticky, false);

  // Switching card variant to Apple liquid glass
  cfg.popup.cardVariant = 'glass';
  const pGlass = evaluatePolicy({ kind: 'done', durationMs: 15_000, canceled: false }, cfg);
  assert.equal(pGlass.channels.popup.cardVariant, 'glass');

  // Long task -> escalated modal
  const pLong = evaluatePolicy({ kind: 'done', durationMs: 45_000, canceled: false }, cfg);
  assert.equal(pLong.shouldNotify, true);
  assert.equal(pLong.tier, 'escalated');
  assert.equal(pLong.channels.popup.style, 'modal');

  // Focused downgrade
  cfg.policy.whenTargetFocused = 'downgrade';
  const pFocus = evaluatePolicy({ kind: 'done', durationMs: 45_000, canceled: false }, cfg, { targetIsFocused: true });
  assert.equal(pFocus.shouldNotify, true);
  assert.equal(pFocus.tier, 'subtle');
  assert.equal(pFocus.channels.popup.style, 'banner');
  assert.equal(pFocus.channels.sound, false);

  // User canceled -> silent
  const pCancel = evaluatePolicy({ kind: 'info', durationMs: 60_000, canceled: true }, cfg);
  assert.equal(pCancel.shouldNotify, false);
  assert.equal(pCancel.reason, 'user_canceled');
});

test('webhook payloads and HMAC signatures generate valid structures', () => {
  const event = {
    agent: 'antigravity',
    agentLabel: 'Antigravity',
    kind: 'done',
    title: '任务已完成',
    message: '全部测试通过',
    project: 'notices',
    durationMs: 65_000,
  };

  const feishu = buildFeishuPayload(event, { secret: 'my-secret', timestampSec: 1700000000 });
  assert.equal(feishu.msg_type, 'interactive');
  assert.equal(feishu.card.header.template, 'green');
  assert.equal(feishu.timestamp, '1700000000');
  assert.ok(feishu.sign && feishu.sign.length > 20);

  const dt = buildDingTalkRequest(event, {
    url: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    secret: 'SEC123',
    timestampMs: 1700000000000,
  });
  assert.match(dt.url, /timestamp=1700000000000&sign=/);
  assert.equal(dt.body.msgtype, 'markdown');

  const wecom = buildWeComPayload(event);
  assert.equal(wecom.msgtype, 'markdown');
  assert.match(wecom.markdown.content, /notices/);
});

test('hook installer safely merges, preserves existing hooks, and uninstalls cleanly across all 4 agents', () => {
  const fakeHome = path.join(tmpRoot, 'fake-home');
  fs.mkdirSync(path.join(fakeHome, '.gemini', 'config'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });

  // Pre-seed user's own hooks to ensure we never clobber them
  fs.writeFileSync(
    path.join(fakeHome, '.gemini', 'config', 'hooks.json'),
    JSON.stringify({ 'my-existing-linter': { PostToolUse: [] } }, null, 2)
  );
  fs.writeFileSync(
    path.join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo custom' }] }] } }, null, 2)
  );
  fs.writeFileSync(
    path.join(fakeHome, '.codex', 'config.toml'),
    'model = "gpt-5"\n\n[mcp_servers.demo]\ncommand = "npx"\n'
  );

  const installed = installHooks(['all'], { homeDir: fakeHome });
  assert.equal(installed.every((r) => r.ok), true);

  // Idempotent re-install must not duplicate Claude hooks
  installHooks(['all'], { homeDir: fakeHome });
  const claudeJson = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeJson.model, 'opus');
  assert.equal(claudeJson.hooks.Stop.length, 2); // 1 user custom + 1 agent-notices

  const agyJson = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gemini', 'config', 'hooks.json'), 'utf8'));
  assert.ok('my-existing-linter' in agyJson);
  assert.ok('agent-notices' in agyJson);

  const statusAfterInstall = getHooksStatus({ homeDir: fakeHome });
  assert.equal(statusAfterInstall.antigravity.installed, true);
  assert.equal(statusAfterInstall.claude.installed, true);
  assert.equal(statusAfterInstall.codex.installed, true);
  assert.equal(statusAfterInstall.cursor.installed, true);

  // Uninstall leaves user's custom hooks untouched
  uninstallHooks(['all'], { homeDir: fakeHome });
  const statusAfterUninstall = getHooksStatus({ homeDir: fakeHome });
  assert.equal(statusAfterUninstall.antigravity.installed, false);
  assert.equal(statusAfterUninstall.claude.installed, false);
  assert.equal(statusAfterUninstall.codex.installed, false);
  assert.equal(statusAfterUninstall.cursor.installed, false);

  const agyAfter = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gemini', 'config', 'hooks.json'), 'utf8'));
  assert.ok('my-existing-linter' in agyAfter);
  const claudeAfter = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeAfter.hooks.Stop.length, 1);
});

test('CLI hook responds immediately with valid Antigravity Stop JSON', () => {
  const start = Date.now();
  const res = spawnSync(process.execPath, [CLI_PATH, 'hook', 'antigravity', '--event', 'Stop'], {
    input: JSON.stringify({
      conversationId: 'cli-e2e-1',
      workspacePaths: ['/tmp/e2e-project'],
      terminationReason: 'USER_CANCELED', // silent so test doesn't pop up a window
    }),
    env: { ...process.env, AGENT_NOTICES_HOME: process.env.AGENT_NOTICES_HOME },
    encoding: 'utf8',
  });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { decision: 'stop' });
  assert.ok(elapsed < 1500, `Expected fast non-blocking hook response, got ${elapsed}ms`);
});

test('Web UI server serves HTML and state/config APIs on ephemeral port', async () => {
  const server = createUiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const htmlResp = await fetch(`${base}/`);
    assert.equal(htmlResp.status, 200);
    const html = await htmlResp.text();
    assert.match(html, /AgentNotices/);

    const stateResp = await fetch(`${base}/api/state`);
    assert.equal(stateResp.status, 200);
    const st = await stateResp.json();
    assert.ok(st.config && st.hooks);

    const putResp = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ popup: { style: 'banner' } }),
    });
    const putData = await putResp.json();
    assert.equal(putData.ok, true);
    assert.equal(putData.config.popup.style, 'banner');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
