/**
 * migration.js — Focus Mode Detector
 *
 * Checks for old flat-format data in chrome.storage.local:
 *   { "youtube.com": 120, "chatgpt.com": 300, "lastUpdatedDate": "2026-04-28" }
 * and migrates it to the new nested format:
 *   { dailyUsage: { "2026-04-28": { "youtube.com": 120, "chatgpt.com": 300 } } }
 */

function migrateDataIfNeeded(callback) {
  chrome.storage.local.get(null, (result) => {
    // If dailyUsage already exists, migration has either been done or isn't needed.
    if (result.dailyUsage) {
      if (callback) callback();
      return;
    }

    const metaKeys = new Set([
      'focusMode', 'dailyBreakCount', 'lastUpdatedDate',
      'focusScore', 'globalVelocitySum', 'globalVelocitySamples', 'dailyUsage'
    ]);

    const dailyUsage = {};
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    // Target date for migration (use lastUpdatedDate if available, else today)
    const targetDate = result.lastUpdatedDate || todayStr;
    const newDayBucket = {};
    const keysToRemove = [];

    for (const [key, value] of Object.entries(result)) {
      if (!metaKeys.has(key)) {
        // It's a flat domain key
        newDayBucket[key] = value;
        keysToRemove.push(key);
      }
    }

    // Only migrate if we found old domain data
    if (Object.keys(newDayBucket).length > 0) {
      dailyUsage[targetDate] = newDayBucket;
      
      chrome.storage.local.set({ dailyUsage }, () => {
        if (keysToRemove.length > 0) {
          chrome.storage.local.remove(keysToRemove, () => {
            if (callback) callback();
          });
        } else {
          if (callback) callback();
        }
      });
    } else {
      if (callback) callback();
    }
  });
}
