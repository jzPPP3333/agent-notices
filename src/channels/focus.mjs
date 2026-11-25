import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Return the currently focused macOS application { appName, bundleId }, or null on other platforms.
 */
export async function getFrontmostApp() {
  if (process.platform !== 'darwin') return null;
  const script =
    'tell application "System Events" to get {name, bundle identifier} of first application process whose frontmost is true';
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 1500 });
    const parts = stdout.trim().split(',').map((s) => s.trim());
    return {
      appName: parts[0] || '',
      bundleId: parts[1] || '',
    };
  } catch {
    return null;
  }
}

export function isSameFocusTarget(frontmost, target) {
  if (!frontmost || !target) return false;
  if (frontmost.bundleId && target.bundleId) {
    if (frontmost.bundleId.toLowerCase() === target.bundleId.toLowerCase()) return true;
  }
  if (frontmost.appName && target.appName) {
    if (frontmost.appName.toLowerCase() === target.appName.toLowerCase()) return true;
  }
  return false;
}

/**
 * Bring target IDE or terminal window to the foreground on macOS.
 */
export async function focusApp(focusTarget) {
  if (process.platform !== 'darwin' || !focusTarget) return false;
  const bundleId = focusTarget.bundleId || '';
  const appName = focusTarget.appName || '';
  const hint = focusTarget.windowHint || '';

  try {
    if (bundleId) {
      const safeId = bundleId.replace(/"/g, '\\"');
      await execFileAsync('/usr/bin/osascript', ['-e', `tell application id "${safeId}" to activate`], {
        timeout: 2000,
      });
    } else if (appName) {
      const safeName = appName.replace(/"/g, '\\"');
      await execFileAsync('/usr/bin/osascript', ['-e', `tell application "${safeName}" to activate`], {
        timeout: 2000,
      });
    } else {
      return false;
    }

    if (hint && appName) {
      const safeApp = appName.replace(/"/g, '\\"');
      const safeHint = hint.replace(/"/g, '\\"');
      const script = `
        tell application "System Events"
          if exists process "${safeApp}" then
            tell process "${safeApp}"
              repeat with w in windows
                try
                  if (name of w) contains "${safeHint}" then
                    perform action "AXRaise" of w
                    exit repeat
                  end if
                end try
              end repeat
            end tell
          end if
        end tell
      `;
      await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 2000 }).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}
