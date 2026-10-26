// Snap Vanish — isolated-world bridge.
// Relays settings and popup/shortcut commands between the extension and the
// page-world hook (inject.js), which has no access to chrome.* APIs.
(() => {
  'use strict';
  const TO_PAGE = '__snapvanish_to_page';
  const FROM_PAGE = '__snapvanish_from_page';
  const DEFAULTS = globalThis.SNAP_VANISH_DEFAULTS;
  const isTop = window === window.top;
  let settings = { ...DEFAULTS };
  let loaded = false;
  let status = null;

  const toPage = (msg) => window.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  const sendConfig = () => toPage({ type: 'config', settings, extBase: chrome.runtime.getURL('') });

  function toExtension(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension was reloaded/updated; this page needs a refresh.
    }
  }

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    loaded = true;
    sendConfig();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) if (k in DEFAULTS) settings[k] = v.newValue ?? DEFAULTS[k];
    toPage({ type: 'settings', settings });
  });

  window.addEventListener(FROM_PAGE, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.type === 'hello') { if (loaded) sendConfig(); } // otherwise sent once storage has loaded
    else if (msg.type === 'status') {
      status = msg.status;
      toExtension({ type: 'session-status', status });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      if (isTop) sendResponse({ ok: true, host: location.hostname });
    } else if (msg.type === 'snap-now') {
      toPage({ type: 'snap-now' });
      sendResponse({ ok: true });
    }
  });

  window.addEventListener('pagehide', () => {
    if (status && status.hasSession) toExtension({ type: 'session-status', status: { ...status, hasSession: false } });
  });
})();
