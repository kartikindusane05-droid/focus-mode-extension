/**
 * dashboard.js — Focus Mode Detector (Dashboard Script)
 *
 * Renders the full-page analytics dashboard with:
 *  • Today's focus score
 *  • Per-site time breakdown (from today's dailyUsage bucket)
 *  • Weekly activity bar chart — fixed Mon–Sun columns, always 7 bars
 *
 * Data shape expected in chrome.storage.local:
 *   {
 *     dailyUsage: {
 *       "2026-04-28": { "youtube.com": 1200, "github.com": 600 },
 *       "2026-04-27": { "reddit.com": 300 }
 *     },
 *     focusScore: 87,
 *     ...
 *   }
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** All 7 weekday abbreviations in Mon–Sun order. */
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats a duration in seconds into a human-readable string.
 * Examples: 3661 → "1h 1m" | 75 → "1m 15s" | 9 → "9s"
 * @param {number} secs
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
 * Converts a YYYY-MM-DD string to a "Mon"–"Sun" abbreviation using local time.
 * Constructs the Date with explicit year/month/day to avoid UTC→local shift.
 * @param {string} dateStr
 * @returns {string}
 */
function dateStringToDayName(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day); // local midnight, no UTC offset
  return date.toLocaleDateString('en-US', { weekday: 'short' }); // "Mon"–"Sun"
}

/**
 * Returns the last 7 calendar dates (including today) as YYYY-MM-DD strings,
 * from oldest (index 0) to newest (index 6 = today).
 * @returns {string[]}
 */
function getLast7Dates() {
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}

/**
 * Sums all hostname seconds within a single day's usage bucket.
 * @param {Object} dayBucket - e.g. { "youtube.com": 1200, "github.com": 600 }
 * @returns {number} Total seconds for that day.
 */
function sumDayBucket(dayBucket) {
  return Object.values(dayBucket || {}).reduce((total, secs) => total + (Number(secs) || 0), 0);
}

// ─── Chart rendering ──────────────────────────────────────────────────────────

/**
 * Renders a single bar + label pair into the weekly chart.
 * @param {HTMLElement} chartEl   - The bar chart container.
 * @param {HTMLElement} labelsEl  - The label row container.
 * @param {string}      dayLabel  - Short weekday name, e.g. "Mon".
 * @param {number}      timeSecs  - Seconds tracked on that day.
 * @param {number}      maxTime   - Maximum time across all bars (for scaling).
 * @param {boolean}     isToday   - Whether this bar represents today.
 */
function renderChartBar(chartEl, labelsEl, dayLabel, timeSecs, maxTime, isToday) {
  const percent  = maxTime > 0 ? (timeSecs / maxTime) * 100 : 0;
  const hours    = Math.floor(timeSecs / 3600);
  const minutes  = Math.floor((timeSecs % 3600) / 60);
  const valLabel = timeSecs === 0 ? '' : (hours > 0 ? `${hours}h` : `${minutes}m`);

  const barWrap = document.createElement('div');
  barWrap.className = 'bar-wrapper';
  barWrap.innerHTML = `
    <span class="bar-value">${valLabel}</span>
    <div class="bar${isToday ? ' bar--today' : ''}" style="height:${Math.max(percent, timeSecs > 0 ? 2 : 0)}%"></div>
  `;
  chartEl.appendChild(barWrap);

  const labelEl = document.createElement('div');
  labelEl.className   = `chart-label${isToday ? ' chart-label--today' : ''}`;
  labelEl.textContent = isToday ? 'Today' : dayLabel;
  labelsEl.appendChild(labelEl);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(null, (result) => {

    // ── 1. Focus Score ───────────────────────────────────────────
    const focusScore = result.focusScore !== undefined ? Math.round(result.focusScore) : 100;
    document.getElementById('dashFocusScore').textContent = focusScore;

    // ── 2. Per-site time breakdown (today only) ──────────────────
    const sitesListEl  = document.getElementById('dashSitesList');
    const todayStr     = getTodayString();
    const dailyUsage   = result.dailyUsage || {};
    const todayBucket  = dailyUsage[todayStr] || {};

    const siteEntries = Object.entries(todayBucket)
      .map(([site, time]) => ({ site, time: Number(time) || 0 }))
      .filter(({ time }) => time > 0)
      .sort((a, b) => b.time - a.time);

    if (siteEntries.length === 0) {
      sitesListEl.innerHTML = '<div class="empty-state">No sites tracked today</div>';
    } else {
      siteEntries.forEach(({ site, time }) => {
        const el = document.createElement('div');
        el.className = 'site-item';
        el.innerHTML = `<span class="site-name">${site}</span><span class="site-time">${formatTime(time)}</span>`;
        sitesListEl.appendChild(el);
      });
    }

    // ── 3. Weekly activity chart (fixed Mon–Sun, last 7 days) ────
    const chartEl     = document.getElementById('dashChart');
    const labelsEl    = document.getElementById('dashChartLabels');
    const chartCardEl = chartEl.closest('.chart-card');

    // Build an ordered array of the last 7 calendar dates
    const last7Dates = getLast7Dates(); // [oldest … today]

    // Map each date to total seconds tracked that day
    const dailyTotals = last7Dates.map(dateStr => sumDayBucket(dailyUsage[dateStr]));

    // Check whether we have any data at all
    const hasAnyData = dailyTotals.some(t => t > 0);

    if (!hasAnyData) {
      chartEl.style.display  = 'none';
      labelsEl.style.display = 'none';

      const emptyMsg = document.createElement('div');
      emptyMsg.className   = 'empty-state';
      emptyMsg.textContent = 'No data available yet. Start using Focus Mode to see your weekly activity.';
      chartCardEl.appendChild(emptyMsg);
      return;
    }

    const maxTime = Math.max(...dailyTotals);

    last7Dates.forEach((dateStr, idx) => {
      const dayLabel = dateStringToDayName(dateStr); // "Mon"–"Sun"
      const isToday  = dateStr === todayStr;
      renderChartBar(chartEl, labelsEl, dayLabel, dailyTotals[idx], maxTime, isToday);
    });
  });
});
