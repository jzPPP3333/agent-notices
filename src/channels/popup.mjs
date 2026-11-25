import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatDuration } from '../store.mjs';
import { sendSystemNotification } from './system.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const MACOS_POPUP_BIN = path.join(PROJECT_ROOT, 'dist', 'macos', 'NoticesPopup');
export const MACOS_MENUBAR_BIN = path.join(PROJECT_ROOT, 'dist', 'macos', 'NoticesMenuBar');
export const CLI_ENTRY = path.join(PROJECT_ROOT, 'bin', 'agent-notices.mjs');

export function hasNativeMacPopup() {
  return process.platform === 'darwin' && fs.existsSync(MACOS_POPUP_BIN);
}

/**
 * Show desktop popup. Uses compiled Swift AppKit NSPanel on macOS (non-focus-stealing,
 * cross-space, frosted glass, clickable focus & mute buttons, multi-popup stacking),
 * falling back cleanly on Linux / Windows or if binary isn't built yet.
 */
export async function showDesktopPopup(event, popupPlan) {
  if (!popupPlan?.enabled) return { ok: true, skipped: true };

  if (hasNativeMacPopup()) {
    const payload = {
      id: event.id,
      agent: event.agent,
      agentLabel: event.agentLabel || event.agent,
      kind: event.kind || 'done',
      title: event.title || '会话任务已完成',
      message: event.message || '',
      project: event.project || 'Workspace',
      durationText: formatDuration(event.durationMs),
      style: popupPlan.style || 'card',
      position: popupPlan.position || 'top-right',
      durationSeconds: popupPlan.sticky ? 0 : Number(popupPlan.durationSeconds ?? 10),
      sticky: Boolean(popupPlan.sticky),
      theme: popupPlan.theme || 'auto',
      showFocusButton: popupPlan.showFocusButton !== false,
      showMuteButton: popupPlan.showMuteButton !== false,
      focusAppName: event.focusTarget?.appName || '',
      focusBundleId: event.focusTarget?.bundleId || '',
      focusWindowHint: event.focusTarget?.windowHint || event.project || '',
      cliPath: CLI_ENTRY,
      nodePath: process.execPath,
    };

    const tmpFile = path.join(
      os.tmpdir(),
      `agent-notices-popup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`
    );
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');

    const child = spawn(MACOS_POPUP_BIN, ['--payload', tmpFile, '--cleanup'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, driver: 'macos-native-popup', style: payload.style };
  }

  // Fallback for Windows: non-blocking PowerShell toast/balloon or MessageBox
  if (process.platform === 'win32') {
    return showWindowsPopupFallback(event, popupPlan);
  }

  // Fallback for Linux / macOS without compiled binary
  await sendSystemNotification(event);
  return { ok: true, driver: 'system-fallback' };
}

function showWindowsPopupFallback(event, popupPlan) {
  return new Promise((resolve) => {
    const title = `${event.agentLabel || 'Agent'} · ${event.project || ''}`.replace(/'/g, "''");
    const body = `${event.title || ''}\n${event.message || ''}`.replace(/'/g, "''");
    const ps =
      popupPlan.style === 'modal'
        ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${body}', '${title}', 'OK', 'Information') | Out-Null`
        : `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(8000, '${title}', '${body}', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 9; $n.Dispose()`;

    execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { timeout: 12000 }, () => {
      resolve({ ok: true, driver: 'windows-powershell' });
    });
  });
}
