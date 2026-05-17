/**
 * content.js — Focus Mode Detector (Content Script)
 *
 * Injected into every page via manifest.json (content_scripts → <all_urls>).
 *
 * Responsibilities:
 *  • Track time spent on the current hostname (in-memory, flushed every 12 s)
 *  • Store usage under dailyUsage["YYYY-MM-DD"][hostname] in chrome.storage.local
 *  • Prune entries older than 7 days on each flush
 *  • Monitor scroll velocity to detect mindless browsing
 *  • Show warning / break overlays when distraction thresholds are exceeded
 *  • Maintain a weighted focus score, updated every second
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Current page hostname, stripped of "www." prefix. */
const HOSTNAME = window.location.hostname.replace('www.', '');

/** Seconds between each chrome.storage.local write (batches disk I/O). */
const FLUSH_INTERVAL_TICKS = 12;

/** Minimum milliseconds between consecutive break prompts (10 minutes). */
const COOLDOWN_PERIOD_MS = 10 * 60 * 1000;

/**
 * Website Categories for Focus Score Calculation
 * Easily editable lists to classify browsing behavior.
 */
const SITE_CATEGORIES = {
  productive: [
    'docs.google.com', 'github.com', 'chatgpt.com',
    'claude.ai', 'stackoverflow.com', 'notion.so'
  ],
  distracting: [
    'youtube.com', 'instagram.com', 'netflix.com',
    'facebook.com', 'twitter.com'
  ]
};

/**
 * Explicit list of meta keys read from storage on startup.
 * Site-time data now lives under the single "dailyUsage" object.
 */
const REQUIRED_KEYS = [
  'focusMode', 'lastUpdatedDate', 'dailyBreakCount',
  'focusScore', 'globalVelocitySum', 'globalVelocitySamples',
  'dailyUsage',
];

// ─── In-memory state ──────────────────────────────────────────────────────────

/**
 * Single source of truth for all runtime data.
 * Seeded once from chrome.storage on load; flushed periodically and on unload.
 */
const state = {
  // Focus mode toggle
  isFocusModeActive: false,

  // Time tracking
  timeSpent: 0, // seconds on current hostname today

  // Focus score & adaptive velocity baseline
  focusScore:            100,
  globalVelocitySum:     0,
  globalVelocitySamples: 0,

  // Daily metadata
  dailyBreakCount: 0,
  todayUsage: {},
  lastUpdatedDate: new Date().toISOString().split('T')[0],

  // Scroll tracking (never persisted to storage)
  lastScrollPos:             0,
  lastScrollEventTime:       0,
  currentVelocity:           0,
  averageVelocity:           0,
  velocitySamples:           [],
  continuousScrollStartTime: 0,
  isScrollingContinuously:   false,

  // Warning / break state
  warningShown:    false,
  warningCount:    0,
  lastBreakTime:   0,
  isPostBreakMode: false,

  // Internal
  ticksSinceFlush:  0,
  trackingInterval: null,
};

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Returns true when the Chrome extension context is still alive.
 * Guards against "Extension context invalidated" errors on stale pages.
 * @returns {boolean}
 */
function isContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

/**
 * Returns today's date as YYYY-MM-DD (local time, not UTC).
 * @returns {string}
 */
function getTodayString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns a new dailyUsage object with entries older than 7 days removed.
 * @param {Object} dailyUsage - The full dailyUsage map from storage.
 * @returns {Object} Pruned copy.
 */
function pruneDailyUsage(dailyUsage) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const pruned = {};
  for (const date of Object.keys(dailyUsage)) {
    if (date >= cutoffStr) pruned[date] = dailyUsage[date];
  }
  return pruned;
}

/**
 * Resets all scroll-tracking fields to a clean baseline.
 * Called after a break completes or the user dismisses a warning.
 */
function resetScrollState() {
  state.lastScrollPos             = window.scrollY;
  state.lastScrollEventTime       = Date.now();
  state.currentVelocity           = 0;
  state.averageVelocity           = 0;
  state.velocitySamples           = [];
  state.continuousScrollStartTime = Date.now();
  state.isScrollingContinuously   = false;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Seeds in-memory state from chrome.storage.local (single read on startup).
 * Reads today's seconds from dailyUsage[today][hostname].
 * Handles day-rollover by resetting daily counters while preserving the
 * long-term velocity baseline used for adaptive threshold calculation.
 * @param {() => void} [callback] - Invoked after state is populated.
 */
function seedStateFromStorage(callback) {
  if (!isContextValid()) return;

  chrome.storage.local.get(REQUIRED_KEYS, (result) => {
    if (chrome.runtime.lastError) {
      console.warn('[FocusMode] Storage seed error:', chrome.runtime.lastError.message);
      return;
    }

    const today      = getTodayString();
    const isNewDay   = result.lastUpdatedDate !== today;
    const dailyUsage = result.dailyUsage || {};
    const todayData  = dailyUsage[today]  || {};

    if (isNewDay) {
      // New day — reset daily counters; keep velocity baseline across sessions
      state.timeSpent             = 0;
      state.todayUsage            = {};
      state.focusScore            = 100;
      state.dailyBreakCount       = 0;
      state.lastUpdatedDate       = today;
      state.globalVelocitySum     = result.globalVelocitySum    || 0;
      state.globalVelocitySamples = result.globalVelocitySamples || 0;
    } else {
      // Same day — restore this hostname's tracked seconds from today's bucket
      state.timeSpent             = todayData[HOSTNAME]          || 0;
      state.todayUsage            = todayData;
      state.focusScore            = result.focusScore            ?? 100;
      state.dailyBreakCount       = result.dailyBreakCount       || 0;
      state.lastUpdatedDate       = today;
      state.globalVelocitySum     = result.globalVelocitySum     || 0;
      state.globalVelocitySamples = result.globalVelocitySamples || 0;
    }

    state.isFocusModeActive = !!result.focusMode;
    if (callback) callback();
  });
}

/**
 * Persists the current in-memory state to chrome.storage.local.
 * Writes usage under dailyUsage[today][hostname] and prunes entries > 7 days.
 */
function flushToStorage() {
  if (!isContextValid()) return;

  const today = getTodayString();

  // Read current dailyUsage first so we don't overwrite other hostnames' data
  chrome.storage.local.get(['dailyUsage'], (result) => {
    if (chrome.runtime.lastError) {
      console.warn('[FocusMode] Storage flush read error:', chrome.runtime.lastError.message);
      return;
    }

    let dailyUsage = result.dailyUsage || {};

    // Ensure today's bucket exists
    if (!dailyUsage[today]) dailyUsage[today] = {};

    // Update this hostname's time within today's bucket
    dailyUsage[today][HOSTNAME] = state.timeSpent;

    // Prune entries older than 7 days to keep storage lean
    dailyUsage = pruneDailyUsage(dailyUsage);

    chrome.storage.local.set({
      dailyUsage,
      focusScore:            state.focusScore,
      dailyBreakCount:       state.dailyBreakCount,
      lastUpdatedDate:       today,
      globalVelocitySum:     state.globalVelocitySum,
      globalVelocitySamples: state.globalVelocitySamples,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FocusMode] Storage flush error:', chrome.runtime.lastError.message);
      }
    });
  });
}

// ─── Focus score calculation ──────────────────────────────────────────────────

/**
 * Returns the category of a given domain.
 * @param {string} domain - The hostname to check.
 * @returns {"productive" | "distracting" | "neutral"}
 */
function getWebsiteCategory(domain) {
  if (SITE_CATEGORIES.productive.some(site => domain.includes(site))) {
    return 'productive';
  }
  if (SITE_CATEGORIES.distracting.some(site => domain.includes(site))) {
    return 'distracting';
  }
  return 'neutral';
}

/**
 * Calculates state.focusScore dynamically based on global usage.
 *
 * Scoring model:
 *   weightedTime = (productive * 1.0) + (neutral * 0.5) + (distracting * -0.7)
 *   score = (weightedTime / totalTrackedTime) × 100
 */
function calculateFocusScore() {
  // Ensure current hostname's time is up to date in the daily map
  state.todayUsage[HOSTNAME] = state.timeSpent;

  let productiveTime = 0;
  let neutralTime = 0;
  let distractingTime = 0;

  for (const [site, time] of Object.entries(state.todayUsage)) {
    const category = getWebsiteCategory(site);
    if (category === 'productive') {
      productiveTime += time;
    } else if (category === 'distracting') {
      distractingTime += time;
    } else {
      neutralTime += time;
    }
  }

  const totalTrackedTime = productiveTime + neutralTime + distractingTime;

  if (totalTrackedTime === 0) {
    state.focusScore = 100;
    return;
  }

  // Apply weights
  const productiveWeight = 1.0;
  const neutralWeight = 0.5;
  const distractingWeight = -0.7;

  let weightedTime = (productiveTime * productiveWeight) + 
                     (neutralTime * neutralWeight) + 
                     (distractingTime * distractingWeight);

  // Convert to percentage
  let score = (weightedTime / totalTrackedTime) * 100;

  // Penalty for excessive breaks (more than 3 breaks)
  if (state.dailyBreakCount > 3) {
    score -= (state.dailyBreakCount - 3) * 2;
  }

  // Ensure score stays bounded and allows smooth values (e.g. 45, 72, 88)
  state.focusScore = Math.max(0, Math.min(100, Math.round(score)));
}

// ─── UI: Post-break toast ─────────────────────────────────────────────────────

/**
 * Displays a brief success toast at the bottom of the page after a break ends.
 */
function showPostBreakToast() {
  if (!document.body) return;

  const toast = document.createElement('div');
  toast.textContent = 'Nice! You took a break. Stay focused 👍';
  toast.style.cssText = `
    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
    background: #10b981; color: white; padding: 12px 24px; border-radius: 8px;
    font-size: 15px; font-weight: 500; box-shadow: 0 4px 12px rgba(16,185,129,0.3);
    z-index: 9999999; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    opacity: 0; transition: opacity 0.3s ease;
  `;
  document.body.appendChild(toast);

  setTimeout(() => { toast.style.opacity = '1'; }, 10); // fade in

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      if (document.body.contains(toast)) document.body.removeChild(toast);
    }, 300);
  }, 3500);
}

// ─── UI: Break overlay ────────────────────────────────────────────────────────

/**
 * Locks the page with a fullscreen break overlay and counts down a timer.
 * Scroll tracking and the site timer are reset when the break ends.
 * @param {number} [duration=30] - Break length in seconds.
 */
function startBreak(duration = 30) {
  if (!document.body) return;
  if (document.getElementById('focus-mode-break-overlay')) return;

  const originalOverflow        = document.body.style.overflow;
  document.body.style.overflow  = 'hidden';

  const overlay = document.createElement('div');
  overlay.id = 'focus-mode-break-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
    display: flex; justify-content: center; align-items: center;
    z-index: 9999999; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    opacity: 0; transition: opacity 0.4s ease;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white; padding: 40px; border-radius: 16px; text-align: center;
    box-shadow: 0 20px 40px rgba(0,0,0,0.2); max-width: 400px; width: 100%;
    transform: scale(0.95); transition: transform 0.4s ease;
  `;

  const title = document.createElement('h2');
  title.textContent = 'Take a short break';
  title.style.cssText = 'font-size: 24px; font-weight: 700; margin: 0 0 16px 0; color: #111827;';

  const timerDisplay = document.createElement('div');
  timerDisplay.style.cssText = 'font-size: 64px; font-weight: 700; color: #3b82f6; margin: 24px 0; font-variant-numeric: tabular-nums;';
  timerDisplay.textContent = duration;

  const subtitle = document.createElement('p');
  subtitle.textContent = "Relax your mind… you'll be back shortly";
  subtitle.style.cssText = 'font-size: 16px; font-weight: 500; color: #6b7280; margin: 0;';

  modal.appendChild(title);
  modal.appendChild(timerDisplay);
  modal.appendChild(subtitle);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Entrance animation
  setTimeout(() => {
    overlay.style.opacity = '1';
    modal.style.transform = 'scale(1)';
  }, 10);

  let timeLeft = duration;

  const countdown = setInterval(() => {
    timeLeft--;
    timerDisplay.textContent = timeLeft;

    if (timeLeft <= 0) {
      clearInterval(countdown);
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
      document.body.style.overflow = originalOverflow;

      resetScrollState();
      state.lastBreakTime   = Date.now();
      state.warningShown    = false;
      state.isPostBreakMode = true;
      state.timeSpent       = 0;

      flushToStorage();
      showPostBreakToast();
    }
  }, 1000);
}

// ─── UI: Warning overlay ──────────────────────────────────────────────────────

/** Rotating prompts shown when a distraction threshold is triggered. */
const WARNING_MESSAGES = [
  'Take a break 😌',
  "You've been scrolling a lot 👀",
  'Focus matters 🔥',
  "Maybe it's time to pause ⏳",
  'Give your mind a rest 💭',
];

/**
 * Shows a warning modal letting the user continue browsing or take a break.
 * Break duration escalates to 60 s after 3+ warnings (default 30 s).
 */
function showWarning() {
  if (!document.body) return;
  if (document.getElementById('focus-mode-warning')) return;

  state.warningCount++;

  const overlay = document.createElement('div');
  overlay.id = 'focus-mode-warning';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.6); backdrop-filter: blur(8px);
    display: flex; justify-content: center; align-items: center;
    z-index: 999999; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    opacity: 0; transition: opacity 0.4s ease;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white; padding: 40px; border-radius: 16px; text-align: center;
    box-shadow: 0 20px 40px rgba(0,0,0,0.2); max-width: 420px; width: 100%;
    transform: scale(0.95); transition: transform 0.4s ease;
  `;

  const message = document.createElement('p');
  message.textContent = WARNING_MESSAGES[Math.floor(Math.random() * WARNING_MESSAGES.length)];
  message.style.cssText = 'font-size: 20px; font-weight: 600; margin: 0 0 24px 0; color: #111827; line-height: 1.4;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; justify-content: center; gap: 16px;';

  /** Closes the overlay and resets scroll state so monitoring resumes cleanly. */
  function dismissWarning() {
    if (document.body.contains(overlay)) document.body.removeChild(overlay);
    resetScrollState();
    state.warningShown = false;
  }

  const continueBtn = document.createElement('button');
  continueBtn.textContent = 'Continue';
  continueBtn.style.cssText = `
    padding: 12px 24px; border: 1px solid #e5e7eb; border-radius: 10px;
    background: #f9fafb; color: #4b5563; cursor: pointer;
    font-size: 15px; font-weight: 600; transition: all 0.2s ease;
  `;
  continueBtn.onmouseover = () => { continueBtn.style.background = '#f3f4f6'; continueBtn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)'; };
  continueBtn.onmouseout  = () => { continueBtn.style.background = '#f9fafb'; continueBtn.style.boxShadow = 'none'; };
  continueBtn.onclick     = dismissWarning;

  const breakBtn = document.createElement('button');
  breakBtn.textContent = 'Take Break';
  breakBtn.style.cssText = `
    padding: 12px 24px; border: none; border-radius: 10px;
    background: #3b82f6; color: white; cursor: pointer;
    font-size: 15px; font-weight: 600; transition: all 0.2s ease;
    box-shadow: 0 4px 6px rgba(59,130,246,0.3);
  `;
  breakBtn.onmouseover = () => { breakBtn.style.background = '#2563eb'; breakBtn.style.boxShadow = '0 6px 12px rgba(59,130,246,0.4)'; breakBtn.style.transform = 'translateY(-1px)'; };
  breakBtn.onmouseout  = () => { breakBtn.style.background = '#3b82f6'; breakBtn.style.boxShadow = '0 4px 6px rgba(59,130,246,0.3)'; breakBtn.style.transform = 'none'; };
  breakBtn.onclick = () => {
    if (document.body.contains(overlay)) document.body.removeChild(overlay);
    state.dailyBreakCount++;
    startBreak(state.warningCount >= 3 ? 60 : 30);           // Escalate duration after 3 warnings
  };

  btnRow.appendChild(continueBtn);
  btnRow.appendChild(breakBtn);
  modal.appendChild(message);
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = '1';
    modal.style.transform = 'scale(1)';
  }, 10);
}

// ─── Scroll listener ──────────────────────────────────────────────────────────

/**
 * Computes real-time scroll velocity using a 10-sample rolling average.
 * Passive listener — never blocks the browser's scroll pipeline.
 */
window.addEventListener('scroll', () => {
  if (!state.isFocusModeActive) return;

  const now        = Date.now();
  const currentPos = window.scrollY;

  if (state.lastScrollEventTime !== 0) {
    const elapsed = now - state.lastScrollEventTime;

    if (elapsed > 0) {
      state.currentVelocity = Math.abs(currentPos - state.lastScrollPos) / elapsed; // px/ms
      state.velocitySamples.push(state.currentVelocity);
      if (state.velocitySamples.length > 10) state.velocitySamples.shift();
      state.averageVelocity = state.velocitySamples.reduce((sum, v) => sum + v, 0) / state.velocitySamples.length;
    }

    // Continuous scrolling = gap between scroll events < 1 s
    if (now - state.lastScrollEventTime < 1000) {
      if (!state.isScrollingContinuously) {
        state.isScrollingContinuously   = true;
        state.continuousScrollStartTime = state.lastScrollEventTime;
      }
    } else {
      state.isScrollingContinuously   = false;
      state.continuousScrollStartTime = now;
    }
  } else {
    state.isScrollingContinuously   = true;
    state.continuousScrollStartTime = now;
  }

  state.lastScrollEventTime = now;
  state.lastScrollPos       = currentPos;
}, { passive: true });

// ─── Main tracking loop ───────────────────────────────────────────────────────

/**
 * Starts a 1-second interval that drives all time tracking and warning logic.
 *
 * Each tick:
 *   1. Increments the site timer
 *   2. Feeds scroll samples into the adaptive velocity baseline
 *   3. Recalculates the focus score
 *   4. Evaluates warning conditions
 *   5. Flushes to storage every FLUSH_INTERVAL_TICKS seconds
 */
function startTracking() {
  state.trackingInterval = setInterval(() => {
    if (!state.isFocusModeActive) return;

    if (!isContextValid()) {
      clearInterval(state.trackingInterval);
      return;
    }

    try {
      const now   = Date.now();
      const today = getTodayString();

      // ── Day rollover ─────────────────────────────────────────
      if (state.lastUpdatedDate !== today) {
        state.timeSpent       = 0;
        state.focusScore      = 100;
        state.dailyBreakCount = 0;
        state.lastUpdatedDate = today;
        flushToStorage();
        return;
      }

      // ── Per-second tick ───────────────────────────────────────
      state.timeSpent++;

      if (state.isScrollingContinuously && state.averageVelocity > 0) {
        state.globalVelocitySum++;
        state.globalVelocitySamples++;
      }

      calculateFocusScore();

      if (now - state.lastScrollEventTime > 1000) {
        state.isScrollingContinuously = false;
      }

      // ── Warning evaluation ────────────────────────────────────
      const timeThreshold    = state.isPostBreakMode ? 120 : 300; // stricter after break
      const hasBaseline      = state.globalVelocitySamples > 15;
      const baselineVelocity = hasBaseline
        ? state.globalVelocitySum / state.globalVelocitySamples
        : 0.1;

      const isExcessiveScrolling = hasBaseline && state.averageVelocity > 2 * baselineVelocity;

      if (
        state.timeSpent > timeThreshold   &&
        isExcessiveScrolling              &&
        !state.warningShown               &&
        now - state.lastBreakTime > COOLDOWN_PERIOD_MS
      ) {
        showWarning();
        state.warningShown    = true;
        state.isPostBreakMode = false;
      }

      // ── Periodic flush ────────────────────────────────────────
      state.ticksSinceFlush++;
      if (state.ticksSinceFlush >= FLUSH_INTERVAL_TICKS) {
        state.ticksSinceFlush = 0;
        flushToStorage();
      }

    } catch (err) {
      console.warn('[FocusMode] Tracking stopped — extension context invalidated.', err);
      clearInterval(state.trackingInterval);
    }
  }, 1000);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * Reacts to focusMode toggle changes from the popup without requiring a page reload.
 */
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.focusMode) {
      state.isFocusModeActive = !!changes.focusMode.newValue;
    }
    if (changes.dailyUsage) {
      const today = getTodayString();
      const newDailyUsage = changes.dailyUsage.newValue || {};
      const todayData = newDailyUsage[today] || {};
      
      // Update todayUsage from other tabs, retaining our own current site time
      for (const [site, time] of Object.entries(todayData)) {
        if (site !== HOSTNAME) {
          state.todayUsage[site] = time;
        }
      }
    }
    if (changes.dailyBreakCount) {
      state.dailyBreakCount = changes.dailyBreakCount.newValue || 0;
    }
  }
});

/**
 * Ensures in-memory state is persisted before the page is destroyed.
 * Prevents data loss between the last scheduled flush and tab close.
 */
window.addEventListener('beforeunload', () => {
  if (state.trackingInterval) clearInterval(state.trackingInterval);
  flushToStorage();
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Seed from storage once, then begin the tracking loop.
seedStateFromStorage(startTracking);
