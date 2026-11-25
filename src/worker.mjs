#!/usr/bin/env node
import fs from 'node:fs';
import { dispatchNotification } from './channels/index.mjs';

async function main() {
  const idx = process.argv.indexOf('--event-file');
  const filePath = idx >= 0 ? process.argv[idx + 1] : null;
  if (!filePath || !fs.existsSync(filePath)) {
    process.exit(0);
  }
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  if (!raw.trim()) process.exit(0);
  const payload = JSON.parse(raw);
  await dispatchNotification(payload.event, payload.options || {});
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
