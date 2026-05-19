'use strict';

const DEFAULT_HISTORY_LIMIT = 50;

function normalizeNavigationUrl(url) {
  if (!url || url === 'about:blank') return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch (_err) {
    return null;
  }
}

function createNavigationHistory(options = {}) {
  const limit = Math.max(1, Number(options.limit) || DEFAULT_HISTORY_LIMIT);
  const entries = [];

  function reset(url) {
    entries.length = 0;
    const normalizedUrl = normalizeNavigationUrl(url);
    if (normalizedUrl) entries.push(normalizedUrl);
  }

  function record(url) {
    const normalizedUrl = normalizeNavigationUrl(url);
    if (!normalizedUrl) return false;

    if (entries[entries.length - 1] === normalizedUrl) return false;

    entries.push(normalizedUrl);
    if (entries.length > limit) {
      entries.splice(0, entries.length - limit);
    }
    return true;
  }

  function previous(currentUrl) {
    const normalizedCurrentUrl = normalizeNavigationUrl(currentUrl);
    while (
      entries.length > 0 &&
      entries[entries.length - 1] === normalizedCurrentUrl
    ) {
      entries.pop();
    }

    return entries.pop() || null;
  }

  function snapshot() {
    return entries.slice();
  }

  return {
    reset,
    record,
    previous,
    snapshot,
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  createNavigationHistory,
  normalizeNavigationUrl,
};
