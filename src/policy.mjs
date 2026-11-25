import { isDndActive } from './config.mjs';

/**
 * Decide whether an event should notify, and at which tier:
 *   - "silent": drop notification (still optionally logged)
 *   - "subtle": lightweight system/banner notification, no forced modal
 *   - "normal": standard configured popup + sound + webhooks
 *   - "escalated": strong popup (modal / sticky) + sound + TTS + webhooks
 */
export function evaluatePolicy(event, config, { now = new Date(), targetIsFocused = false, force = false } = {}) {
  if (force) {
    return buildPlan({
      shouldNotify: true,
      tier: event.kind === 'error' || event.kind === 'attention' ? 'escalated' : 'normal',
      reason: 'forced',
      event,
      config,
    });
  }

  // 1. User canceled event
  if (event.canceled && config.policy?.ignoreUserCanceled !== false) {
    return { shouldNotify: false, tier: 'silent', reason: 'user_canceled', channels: emptyChannels() };
  }

  // 2. Global enable / DND / Quiet Hours
  const dndState = isDndActive(config, now);
  if (dndState.active) {
    return { shouldNotify: false, tier: 'silent', reason: dndState.reason, channels: emptyChannels() };
  }

  const isUrgent = event.kind === 'error' || event.kind === 'attention';
  const durationSec = typeof event.durationMs === 'number' ? event.durationMs / 1000 : null;
  const minSec = Number(config.policy?.minDurationSeconds ?? 5);
  const escalateSec = Number(config.policy?.escalateDurationSeconds ?? 30);

  // 3. Minimum duration threshold (urgent events bypass threshold)
  if (!isUrgent && durationSec !== null && minSec > 0 && durationSec < minSec) {
    return { shouldNotify: false, tier: 'silent', reason: 'below_min_duration', channels: emptyChannels() };
  }

  // 4. Determine initial tier
  let tier = 'normal';
  if (isUrgent) {
    tier = 'escalated';
  } else if (durationSec !== null && escalateSec > 0 && durationSec >= escalateSec) {
    tier = 'escalated';
  }

  // 5. Focused window handling
  const focusMode = config.policy?.whenTargetFocused || 'never';
  if (targetIsFocused && !isUrgent) {
    if (focusMode === 'suppress') {
      return { shouldNotify: false, tier: 'silent', reason: 'target_focused', channels: emptyChannels() };
    }
    if (focusMode === 'downgrade') {
      tier = 'subtle';
    }
  }

  return buildPlan({ shouldNotify: true, tier, reason: 'matched', event, config });
}

function emptyChannels() {
  return {
    popup: { enabled: false },
    system: false,
    sound: false,
    tts: false,
    webhooks: false,
  };
}

function buildPlan({ shouldNotify, tier, reason, event, config }) {
  const isUrgent = event.kind === 'error' || event.kind === 'attention';
  const popupCfg = config.popup || {};

  let popupStyle = popupCfg.style || 'card';
  let sticky = Number(popupCfg.durationSeconds ?? 10) === 0;

  if (tier === 'subtle') {
    popupStyle = 'banner';
    sticky = false;
  } else if (tier === 'escalated') {
    popupStyle = popupCfg.escalatedStyle || 'modal';
    if (isUrgent && popupCfg.stickyOnAttention !== false) {
      sticky = true;
    } else if (!isUrgent && popupCfg.stickyOnEscalated) {
      sticky = true;
    }
  }

  return {
    shouldNotify,
    tier,
    reason,
    channels: {
      popup: {
        enabled: popupCfg.enabled !== false,
        style: popupStyle,
        cardVariant: popupCfg.cardVariant || 'pill',
        position: popupStyle === 'modal' ? 'center' : popupStyle === 'banner' ? 'top-center' : popupCfg.position || 'top-right',
        durationSeconds: sticky ? 0 : Math.max(3, Number(popupCfg.durationSeconds ?? 10)),
        sticky,
        showFocusButton: popupCfg.showFocusButton !== false,
        showMuteButton: popupCfg.showMuteButton !== false,
        theme: popupCfg.theme || 'auto',
      },
      system: Boolean(config.systemNotification?.enabled),
      sound: Boolean(config.sound?.enabled) && tier !== 'subtle',
      tts: Boolean(config.tts?.enabled) && tier !== 'subtle',
      webhooks: tier !== 'subtle',
    },
  };
}
