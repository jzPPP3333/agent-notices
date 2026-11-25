import { loadConfig } from '../config.mjs';
import { appendHistory, checkAndRecordDedupe } from '../store.mjs';
import { buildEventSummary } from '../summary.mjs';
import { evaluatePolicy } from '../policy.mjs';
import { getFrontmostApp, isSameFocusTarget } from './focus.mjs';
import { showDesktopPopup } from './popup.mjs';
import { playNotificationSound, speakNotification } from './sound.mjs';
import { sendSystemNotification } from './system.mjs';
import { dispatchWebhooks } from './webhook.mjs';

/**
 * Full notification pipeline: summarize -> dedupe -> focus check -> policy -> history -> fan-out channels.
 */
export async function dispatchNotification(rawEvent, { config = null, force = false, popupOverrides = null, recordHistory = true } = {}) {
  const cfg = config || loadConfig();
  const event = { ...rawEvent };

  // Build concise summary if message wasn't pre-populated
  if (!event.message) {
    event.message = await buildEventSummary({
      userPrompt: event.userPrompt,
      assistantText: event.assistantText,
      errorText: event.errorText,
      config: cfg,
    });
  }

  // Deduplicate rapid duplicate fires from the same session
  if (!force) {
    const dedupeKey = `${event.agent}:${event.conversationId || 'default'}:${event.kind}:${event.reason || ''}`;
    const windowMs = Number(cfg.policy?.dedupeWindowMs ?? 3000);
    if (checkAndRecordDedupe(dedupeKey, windowMs)) {
      return { delivered: false, reason: 'deduped', event };
    }
  }

  // Optional frontmost app detection
  let targetIsFocused = false;
  if (!force && cfg.policy?.whenTargetFocused && cfg.policy.whenTargetFocused !== 'never') {
    const frontmost = await getFrontmostApp();
    targetIsFocused = isSameFocusTarget(frontmost, event.focusTarget);
  }

  const plan = evaluatePolicy(event, cfg, { targetIsFocused, force });

  if (popupOverrides && plan.channels.popup) {
    plan.channels.popup = { ...plan.channels.popup, ...popupOverrides };
  }

  if (!plan.shouldNotify) {
    return { delivered: false, reason: plan.reason, tier: plan.tier, event };
  }

  if (recordHistory) {
    appendHistory({
      id: event.id,
      timestamp: event.timestamp || new Date().toISOString(),
      agent: event.agent,
      agentLabel: event.agentLabel || event.agent,
      kind: event.kind,
      tier: plan.tier,
      title: event.title,
      message: event.message,
      project: event.project,
      cwd: event.cwd,
      durationMs: event.durationMs ?? null,
      reason: event.reason || '',
      focusTarget: event.focusTarget || null,
    });
  }

  const channelResults = {};
  const tasks = [];

  if (plan.channels.popup?.enabled) {
    tasks.push(
      showDesktopPopup(event, plan.channels.popup).then((r) => {
        channelResults.popup = r;
      })
    );
  }

  if (plan.channels.system) {
    tasks.push(
      sendSystemNotification(event).then((r) => {
        channelResults.system = r;
      })
    );
  }

  if (plan.channels.sound) {
    channelResults.sound = playNotificationSound(event, cfg.sound);
  }

  if (plan.channels.tts) {
    channelResults.tts = speakNotification(event, cfg.tts);
  }

  if (plan.channels.webhooks) {
    tasks.push(
      dispatchWebhooks(event, cfg.webhooks).then((r) => {
        channelResults.webhooks = r;
      })
    );
  }

  await Promise.allSettled(tasks);

  return {
    delivered: true,
    tier: plan.tier,
    reason: plan.reason,
    event,
    channels: channelResults,
  };
}
