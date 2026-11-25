import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatDuration } from '../store.mjs';

const execFileAsync = promisify(execFile);

function escapeAppleScript(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

export async function sendSystemNotification(event) {
  const dur = formatDuration(event.durationMs);
  const title = `${event.agentLabel || 'Agent'} · ${event.project || 'Workspace'}`;
  const subtitle = dur ? `${event.title} (${dur})` : event.title || '任务完成';
  const body = (event.message || '').slice(0, 200);

  if (process.platform === 'darwin') {
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(subtitle)}"`;
    try {
      await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 3000 });
      return { ok: true, driver: 'macos-notification-center' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (process.platform === 'linux') {
    const urgency = event.kind === 'error' ? 'critical' : event.kind === 'attention' ? 'normal' : 'low';
    try {
      await execFileAsync('notify-send', ['-u', urgency, `${title} - ${subtitle}`, body], { timeout: 3000 });
      return { ok: true, driver: 'notify-send' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, skipped: true };
}
