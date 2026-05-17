/**
 * popup.js — Focus Mode Detector (Popup Script)
 *
 * Renders the extension popup with:
 *  • Focus mode toggle (persisted to chrome.storage.local)
 *  • Today's focus score and break count
 *  • Per-site time breakdown for today (read from dailyUsage[today])
 *
 * Data shape expected in chrome.storage.local:
 *   {
 *     dailyUsage: {
 *       "2026-04-28": { "youtube.com": 1200, "github.com": 600 }
 *     },
 *     focusMode:       true,
 *     focusScore:      87,
 *     dailyBreakCount: 2,
 *     lastUpdatedDate: "2026-04-28"
 *   }
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Top-level keys that are metadata — not site hostnames.
 * dailyUsage is the only key that holds site-time data (as a nested object).
 */
const META_KEYS = new Set([
  'focusMode', 'dailyBreakCount', 'lastUpdatedDate',
  'focusScore', 'globalVelocitySum', 'globalVelocitySamples', 'dailyUsage',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats a duration in seconds into a human-readable string.
 * Examples: 3661 → "1h 1m" | 75 → "1m 15s" | 9 → "9s"
 * @param {number} secs - Duration in seconds.
 * @returns {string}
 */
function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Returns today's date as YYYY-MM-DD in local time (avoids UTC offset issues).
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
 * Updates the toggle and status label to reflect the current focus mode state.
 * @param {HTMLInputElement} toggleEl - The checkbox input element.
 * @param {HTMLElement}      labelEl  - The status text element (ON / OFF).
 * @param {boolean}          isActive
 */
function applyFocusModeUI(toggleEl, labelEl, isActive) {
  toggleEl.checked      = isActive;
  labelEl.textContent   = isActive ? 'ON' : 'OFF';
  labelEl.style.color   = isActive ? '#ffffff' : '#9ca3af';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const focusToggle  = document.getElementById('focusToggle');
  const statusText   = document.getElementById('statusText');
  const dailyCountEl = document.getElementById('dailyCount');
  const focusScoreEl = document.getElementById('focusScore');
  const sitesListEl  = document.getElementById('sitesList');

  // Fetch all storage keys in one read
  chrome.storage.local.get(null, (result) => {
    const today      = getTodayString();
    const dailyUsage = result.dailyUsage || {};
    const todayData  = dailyUsage[today] || {};

    // ── Day rollover ───────────────────────────────────────────
    // If the stored date is stale, reset daily counters.
    // Per-site history lives inside dailyUsage (keyed by date) so it is
    // preserved automatically — no data needs to be deleted.
    if (result.lastUpdatedDate !== today) {
      chrome.storage.local.set({
        dailyBreakCount: 0,
        lastUpdatedDate: today,
        focusScore:      100,
      });
      result.dailyBreakCount = 0;
      result.focusScore      = 100;
    }

    // ── Focus mode toggle ──────────────────────────────────────
    applyFocusModeUI(focusToggle, statusText, !!result.focusMode);

    // ── Stats ──────────────────────────────────────────────────
    if (dailyCountEl) dailyCountEl.textContent = result.dailyBreakCount || 0;
    if (focusScoreEl) focusScoreEl.textContent  = result.focusScore !== undefined
      ? Math.round(result.focusScore)
      : 100;

    // ── Per-site time list (today's bucket only) ───────────────
    if (!sitesListEl) return;
    sitesListEl.innerHTML = '';

    const siteEntries = Object.entries(todayData)
      .map(([site, time]) => ({ site, time: Number(time) || 0 }))
      .filter(({ time }) => time > 0)
      .sort((a, b) => b.time - a.time);

    if (siteEntries.length === 0) {
      sitesListEl.innerHTML =
        '<div class="site-item" style="justify-content:center;opacity:0.7;">No sites tracked today</div>';
      return;
    }

    siteEntries.forEach(({ site, time }) => {
      const el = document.createElement('div');
      el.className = 'site-item';
      el.innerHTML = `<span class="site-name">${site}</span><span class="site-time">${formatTime(time)}</span>`;
      sitesListEl.appendChild(el);
    });
  });

  // ── Toggle handler ───────────────────────────────────────────
  focusToggle.addEventListener('change', (e) => {
    const isActive = e.target.checked;
    chrome.storage.local.set({ focusMode: isActive }, () => {
      applyFocusModeUI(focusToggle, statusText, isActive);
    });
  });
});
