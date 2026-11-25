import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getConfigPath,
  getDataDir,
  isDndActive,
  loadConfig,
  saveConfig,
  setDnd,
} from '../config.mjs';
import {
  clearHistory,
  getUnreadCount,
  markAllRead,
  readHistory,
} from '../store.mjs';
import { getHooksStatus, installHooks, uninstallHooks } from '../hooks-installer.mjs';
import { dispatchNotification } from '../channels/index.mjs';
import { sendSingleWebhook } from '../channels/webhook.mjs';
import { listMacSystemSounds } from '../channels/sound.mjs';
import { focusApp } from '../channels/focus.mjs';
import { CLI_ENTRY, hasNativeMacPopup, MACOS_MENUBAR_BIN } from '../channels/popup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, 'public', 'index.html');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function openUrlInBrowser(url) {
  if (process.platform === 'darwin') {
    const c = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' });
    c.unref();
  } else if (process.platform === 'linux') {
    const c = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } else if (process.platform === 'win32') {
    const c = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    c.unref();
  }
}

export function createUiServer() {
  return http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(HTML_PATH, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (method === 'GET' && pathname === '/api/state') {
        const config = loadConfig();
        sendJson(res, 200, {
          config,
          configPath: getConfigPath(),
          dataDir: getDataDir(),
          platform: process.platform,
          dnd: isDndActive(config),
          unread: getUnreadCount(),
          nativePopupReady: hasNativeMacPopup(),
          menubarReady: fs.existsSync(MACOS_MENUBAR_BIN),
          sounds: listMacSystemSounds(),
          hooks: getHooksStatus(),
        });
        return;
      }

      if (method === 'PUT' && pathname === '/api/config') {
        const body = await readBody(req);
        const saved = saveConfig(body, { merge: true });
        sendJson(res, 200, { ok: true, config: saved, dnd: isDndActive(saved) });
        return;
      }

      if (method === 'POST' && pathname === '/api/dnd') {
        const body = await readBody(req);
        const saved = setDnd({
          enabled: Boolean(body.enabled),
          minutes: body.minutes ? Number(body.minutes) : null,
        });
        sendJson(res, 200, { ok: true, config: saved, dnd: isDndActive(saved) });
        return;
      }

      if (method === 'POST' && pathname === '/api/hooks/install') {
        const body = await readBody(req);
        const targets = Array.isArray(body.targets) ? body.targets : body.agent ? [body.agent] : ['auto'];
        const results = installHooks(targets, { force: Boolean(body.force) });
        sendJson(res, 200, { ok: results.every((r) => r.ok), results, hooks: getHooksStatus() });
        return;
      }

      if (method === 'POST' && pathname === '/api/hooks/uninstall') {
        const body = await readBody(req);
        const targets = Array.isArray(body.targets) ? body.targets : body.agent ? [body.agent] : ['all'];
        const results = uninstallHooks(targets);
        sendJson(res, 200, { ok: true, results, hooks: getHooksStatus() });
        return;
      }

      if (method === 'POST' && pathname === '/api/test/popup') {
        const body = await readBody(req);
        const kind = body.kind || 'done';
        const style = body.style || loadConfig().popup?.style || 'card';
        const sampleMessages = {
          done: '已完成核心模块开发并通过全部单元测试，点击按钮即可切回工作窗口。',
          attention: '长任务已运行 1m 42s，等待你确认是否继续合并分支与推送远端。',
          error: '单元测试检测到 1 处断言失败（policy.test.mjs），建议立即查看日志。',
          info: 'AgentNotices 原生多模态弹窗与声音系统运行正常。',
        };
        const sampleTitles = {
          done: '会话任务已完成',
          attention: '任务等待人工确认',
          error: '任务执行出现错误',
          info: '状态测试提醒',
        };

        const event = {
          id: `test_${crypto.randomBytes(5).toString('hex')}`,
          timestamp: new Date().toISOString(),
          agent: body.agent || 'antigravity',
          agentLabel: body.agent === 'claude' ? 'Claude Code' : body.agent === 'codex' ? 'Codex CLI' : body.agent === 'cursor' ? 'Cursor' : 'Antigravity',
          kind,
          title: body.title || sampleTitles[kind] || '测试提醒',
          message: body.message || sampleMessages[kind] || sampleMessages.done,
          project: body.project || 'agent-notices',
          cwd: process.cwd(),
          conversationId: `ui-test-${Date.now()}`,
          durationMs: Number(body.durationSeconds ?? 84) * 1000,
          reason: 'ui_test',
          canceled: false,
          focusTarget: {
            appName: 'Antigravity',
            bundleId: 'com.google.antigravity',
            windowHint: 'notices',
          },
        };

        const popupOverrides = {
          enabled: true,
          style,
          position: style === 'modal' ? 'center' : style === 'banner' ? 'top-center' : body.position || loadConfig().popup?.position || 'top-right',
          sticky: Boolean(body.sticky),
          durationSeconds: body.sticky ? 0 : Number(body.popupDuration ?? 8),
        };

        const result = await dispatchNotification(event, {
          force: true,
          popupOverrides,
          recordHistory: body.recordHistory !== false,
        });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (method === 'POST' && pathname === '/api/test/webhook') {
        const body = await readBody(req);
        const channel = body.channel;
        const cfg = loadConfig();
        const channelCfg = body.channelConfig || cfg.webhooks?.[channel];
        const testEvent = {
          id: `wh_${crypto.randomBytes(5).toString('hex')}`,
          timestamp: new Date().toISOString(),
          agent: 'antigravity',
          agentLabel: 'Antigravity',
          kind: 'done',
          title: 'AgentNotices 通道连通性测试',
          message: '这是一条来自 AgentNotices 本地控制台的测试消息，收到即说明 Webhook 通道配置正确！',
          project: 'agent-notices',
          durationMs: 42_000,
        };
        const result = await sendSingleWebhook(channel, testEvent, channelCfg);
        sendJson(res, 200, { ok: Boolean(result.ok), channel, result });
        return;
      }

      if (method === 'GET' && pathname === '/api/history') {
        const limit = Number(urlObj.searchParams.get('limit') || 60);
        const agent = urlObj.searchParams.get('agent') || null;
        const kind = urlObj.searchParams.get('kind') || null;
        sendJson(res, 200, {
          items: readHistory({ limit, agent, kind }),
          unread: getUnreadCount(),
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/history/read-all') {
        markAllRead();
        sendJson(res, 200, { ok: true, unread: 0 });
        return;
      }

      if (method === 'DELETE' && pathname === '/api/history') {
        clearHistory();
        sendJson(res, 200, { ok: true, unread: 0 });
        return;
      }

      if (method === 'POST' && pathname === '/api/focus') {
        const body = await readBody(req);
        const ok = await focusApp(body.focusTarget);
        sendJson(res, 200, { ok });
        return;
      }

      if (method === 'POST' && pathname === '/api/menubar/start') {
        if (process.platform !== 'darwin' || !fs.existsSync(MACOS_MENUBAR_BIN)) {
          sendJson(res, 400, { ok: false, error: 'macOS 菜单栏助手未编译或当前非 macOS 系统。' });
          return;
        }
        const child = spawn(
          MACOS_MENUBAR_BIN,
          ['--cli', CLI_ENTRY, '--node', process.execPath, '--data-dir', getDataDir()],
          { detached: true, stdio: 'ignore' }
        );
        child.unref();
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });
}

export async function startUiServer({ port = 47890, openBrowser = false } = {}) {
  const server = createUiServer();
  const url = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`AgentNotices Web 控制台已在运行：${url}`);
        if (openBrowser) openUrlInBrowser(url);
        resolve(null);
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`✓ AgentNotices Web 控制台已启动：${url}`);
      console.log('  按 Ctrl+C 停止服务');
      if (openBrowser) openUrlInBrowser(url);
      resolve(server);
    });
  });
}
