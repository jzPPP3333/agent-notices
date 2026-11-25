import crypto from 'node:crypto';
import { formatDuration } from '../store.mjs';

const WEBHOOK_TIMEOUT_MS = 8000;

function statusEmoji(kind) {
  switch (kind) {
    case 'error':
      return '❌';
    case 'attention':
      return '⚠️';
    case 'info':
      return 'ℹ️';
    default:
      return '✅';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildFeishuPayload(event, { secret = '', timestampSec = Math.floor(Date.now() / 1000) } = {}) {
  const dur = formatDuration(event.durationMs);
  const template =
    event.kind === 'error'
      ? 'red'
      : event.kind === 'attention'
        ? 'orange'
        : event.kind === 'info'
          ? 'blue'
          : 'green';

  const metaParts = [`**工具**：${event.agentLabel || event.agent}`, `**项目**：${event.project || 'Workspace'}`];
  if (dur) metaParts.push(`**耗时**：${dur}`);

  const payload = {
    msg_type: 'interactive',
    card: {
      header: {
        template,
        title: {
          tag: 'plain_text',
          content: `${statusEmoji(event.kind)} ${event.title || '会话任务已完成'}`,
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: `${metaParts.join('  |  ')}\n\n${event.message || '会话已结束，可返回查看。'}`,
        },
      ],
    },
  };

  if (secret) {
    const ts = String(timestampSec);
    const stringToSign = `${ts}\n${secret}`;
    const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
    payload.timestamp = ts;
    payload.sign = sign;
  }

  return payload;
}

export function buildDingTalkRequest(event, { url, secret = '', timestampMs = Date.now() } = {}) {
  const dur = formatDuration(event.durationMs);
  let targetUrl = url;
  if (secret) {
    const ts = String(timestampMs);
    const stringToSign = `${ts}\n${secret}`;
    const sign = encodeURIComponent(crypto.createHmac('sha256', secret).update(stringToSign).digest('base64'));
    const sep = targetUrl.includes('?') ? '&' : '?';
    targetUrl = `${targetUrl}${sep}timestamp=${ts}&sign=${sign}`;
  }

  const lines = [
    `### ${statusEmoji(event.kind)} ${event.title || '会话任务已完成'}`,
    `- **工具**：${event.agentLabel || event.agent}`,
    `- **项目**：${event.project || 'Workspace'}`,
  ];
  if (dur) lines.push(`- **耗时**：${dur}`);
  if (event.message) lines.push(`\n> ${event.message}`);

  return {
    url: targetUrl,
    body: {
      msgtype: 'markdown',
      markdown: {
        title: `${event.project || 'Agent'} · ${event.title || '任务完成'}`,
        text: lines.join('\n'),
      },
    },
  };
}

export function buildWeComPayload(event) {
  const dur = formatDuration(event.durationMs);
  const color = event.kind === 'error' ? 'warning' : event.kind === 'attention' ? 'warning' : 'info';
  const lines = [
    `## ${statusEmoji(event.kind)} <font color="${color}">${event.title || '会话任务已完成'}</font>`,
    `> 工具：**${event.agentLabel || event.agent}**`,
    `> 项目：**${event.project || 'Workspace'}**`,
  ];
  if (dur) lines.push(`> 耗时：**${dur}**`);
  if (event.message) lines.push(`\n${event.message}`);

  return {
    msgtype: 'markdown',
    markdown: {
      content: lines.join('\n'),
    },
  };
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, status: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendSingleWebhook(channelName, event, cfg) {
  if (!cfg) return { ok: false, error: 'missing_config' };
  const dur = formatDuration(event.durationMs);

  switch (channelName) {
    case 'feishu': {
      if (!cfg.url) return { ok: false, error: 'missing_feishu_url' };
      const body = buildFeishuPayload(event, { secret: cfg.secret });
      return postJson(cfg.url, body);
    }

    case 'dingtalk': {
      if (!cfg.url) return { ok: false, error: 'missing_dingtalk_url' };
      const { url, body } = buildDingTalkRequest(event, { url: cfg.url, secret: cfg.secret });
      return postJson(url, body);
    }

    case 'wecom': {
      if (!cfg.url) return { ok: false, error: 'missing_wecom_url' };
      return postJson(cfg.url, buildWeComPayload(event));
    }

    case 'bark': {
      if (!cfg.deviceKey) return { ok: false, error: 'missing_bark_device_key' };
      const base = (cfg.serverUrl || 'https://api.day.app').replace(/\/+$/, '');
      const title = `${statusEmoji(event.kind)} ${event.agentLabel || 'Agent'} · ${event.project || ''}`;
      const bodyText = dur ? `[${dur}] ${event.title}\n${event.message || ''}` : `${event.title}\n${event.message || ''}`;
      return postJson(`${base}/push`, {
        device_key: cfg.deviceKey,
        title,
        body: bodyText.trim(),
        sound: cfg.sound || 'bell',
        level: cfg.level || 'timeSensitive',
        group: cfg.group || 'AgentNotices',
      });
    }

    case 'telegram': {
      if (!cfg.botToken || !cfg.chatId) return { ok: false, error: 'missing_telegram_credentials' };
      const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
      const meta = [event.agentLabel || event.agent, event.project || 'Workspace', dur].filter(Boolean).join(' · ');
      const text = `<b>${statusEmoji(event.kind)} ${escapeHtml(event.title)}</b>\n<i>${escapeHtml(meta)}</i>\n\n${escapeHtml(event.message || '')}`;
      return postJson(url, {
        chat_id: cfg.chatId,
        text: text.trim(),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }

    case 'ntfy': {
      if (!cfg.topic) return { ok: false, error: 'missing_ntfy_topic' };
      const base = (cfg.url || 'https://ntfy.sh').replace(/\/+$/, '');
      const endpoint = `${base}/${encodeURIComponent(cfg.topic)}`;
      const headers = {
        Title: `${event.agentLabel || 'Agent'} - ${event.project || 'Workspace'}`,
        Priority: event.kind === 'error' ? '5' : event.kind === 'attention' ? '4' : '3',
        Tags: event.kind === 'error' ? 'rotating_light' : event.kind === 'attention' ? 'warning' : 'white_check_mark',
      };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: `${event.title}${dur ? ` (${dur})` : ''}\n${event.message || ''}`.trim(),
          signal: controller.signal,
        });
        return { ok: resp.ok, status: resp.status };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        clearTimeout(timer);
      }
    }

    case 'custom': {
      if (!cfg.url) return { ok: false, error: 'missing_custom_url' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const resp = await fetch(cfg.url, {
          method: (cfg.method || 'POST').toUpperCase(),
          headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
          body: JSON.stringify({
            source: 'agent-notices',
            event,
            durationText: dur,
          }),
          signal: controller.signal,
        });
        return { ok: resp.ok, status: resp.status };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        clearTimeout(timer);
      }
    }

    default:
      return { ok: false, error: `unknown_channel:${channelName}` };
  }
}

export async function dispatchWebhooks(event, webhooksConfig = {}) {
  const results = {};
  const tasks = [];
  for (const [name, cfg] of Object.entries(webhooksConfig || {})) {
    if (!cfg || !cfg.enabled) continue;
    tasks.push(
      sendSingleWebhook(name, event, cfg).then((res) => {
        results[name] = res;
      })
    );
  }
  await Promise.allSettled(tasks);
  return results;
}
