import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { formatDuration } from '../store.mjs';

const MACOS_SOUNDS_DIR = '/System/Library/Sounds';

export function listMacSystemSounds() {
  if (process.platform !== 'darwin' || !fs.existsSync(MACOS_SOUNDS_DIR)) return [];
  try {
    return fs
      .readdirSync(MACOS_SOUNDS_DIR)
      .filter((f) => f.endsWith('.aiff'))
      .map((f) => f.replace(/\.aiff$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export function resolveSoundFile(soundSetting) {
  if (!soundSetting) return null;
  if (fs.existsSync(soundSetting)) return soundSetting;
  if (process.platform === 'darwin') {
    const withExt = soundSetting.endsWith('.aiff') ? soundSetting : `${soundSetting}.aiff`;
    const sysPath = path.join(MACOS_SOUNDS_DIR, withExt);
    if (fs.existsSync(sysPath)) return sysPath;
  }
  return null;
}

export function playNotificationSound(event, soundConfig) {
  if (!soundConfig?.enabled) return { ok: true, skipped: true };
  const kind = event.kind || 'done';
  const soundName = soundConfig[kind] || soundConfig.done || 'Glass';
  const filePath = resolveSoundFile(soundName);

  if (process.platform === 'darwin' && filePath) {
    const vol = Math.max(0.05, Math.min(1.0, Number(soundConfig.volume ?? 0.85)));
    const child = spawn('/usr/bin/afplay', ['-v', String(vol), filePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, driver: 'afplay', sound: soundName };
  }

  if (process.platform === 'linux' && filePath) {
    const child = spawn('paplay', [filePath], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { ok: true, driver: 'paplay', sound: soundName };
  }

  return { ok: false, skipped: true, reason: 'sound_unavailable' };
}

export function renderTtsText(event, template = '{project}，{title}') {
  const dur = formatDuration(event.durationMs);
  return String(template || '{project}，{title}')
    .replace(/\{agent\}/g, event.agentLabel || event.agent || 'Agent')
    .replace(/\{project\}/g, event.project || '工作区')
    .replace(/\{title\}/g, event.title || '任务已完成')
    .replace(/\{duration\}/g, dur ? `耗时 ${dur}` : '')
    .replace(/\{message\}/g, (event.message || '').slice(0, 60))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function speakNotification(event, ttsConfig) {
  if (!ttsConfig?.enabled) return { ok: true, skipped: true };
  const text = renderTtsText(event, ttsConfig.template);
  if (!text) return { ok: true, skipped: true };

  if (process.platform === 'darwin') {
    const args = [];
    if (ttsConfig.voice) {
      args.push('-v', String(ttsConfig.voice));
    }
    if (ttsConfig.rate) {
      args.push('-r', String(Number(ttsConfig.rate) || 195));
    }
    args.push(text);
    const child = spawn('/usr/bin/say', args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, driver: 'macos-say', text };
  }

  if (process.platform === 'linux') {
    const child = spawn('spd-say', [text], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { ok: true, driver: 'spd-say', text };
  }

  return { ok: false, skipped: true, reason: 'tts_unavailable' };
}
