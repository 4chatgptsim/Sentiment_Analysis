// Snap Vanish — service worker.
// Keeps track of which tab/frame has a live camera session so the keyboard
// shortcut and the popup's "Snap now" reach the meeting even when it is not
// the active tab.
importScripts('shared/defaults.js');

const DEFAULTS = globalThis.SNAP_VANISH_DEFAULTS;
const KEY = 'sessions';

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in current)) missing[k] = v;
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
});

async function getSessions() {
  return (await chrome.storage.session.get(KEY))[KEY] || {};
}

// Status updates arrive in bursts; serialise the read-modify-write.
let queue = Promise.resolve();
function putSession(tabId, frameId, status) {
  queue = queue.then(() => writeSession(tabId, frameId, status)).catch(() => {});
  return queue;
}

async function writeSession(tabId, frameId, status) {
  const sessions = await getSessions();
  const id = `${tabId}:${frameId}`;
  if (status && status.hasSession) sessions[id] = { tabId, frameId, status, updated: Date.now() };
  else delete sessions[id];
  await chrome.storage.session.set({ [KEY]: sessions });
  updateBadge(tabId, sessions);
}

function updateBadge(tabId, sessions) {
  const mine = Object.values(sessions).filter((s) => s.tabId === tabId);
  const gone = mine.some((s) => s.status.state === 'vanished' || s.status.state === 'vanishing');
  chrome.action.setBadgeText({ tabId, text: gone ? 'GONE' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d28d9' }).catch(() => {});
}

// Best session to control: one in the active tab, else the most recently active.
async function findTarget(activeTabId) {
  const list = Object.values(await getSessions());
  if (!list.length) return null;
  const inActive = list.filter((s) => s.tabId === activeTabId);
  const pool = inActive.length ? inActive : list;
  pool.sort((a, b) => b.updated - a.updated);
  // Drop entries for tabs that no longer exist.
  for (const s of pool) {
    try {
      await chrome.tabs.get(s.tabId);
      return s;
    } catch {
      await putSession(s.tabId, s.frameId, null);
    }
  }
  return null;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : -1;
}

async function snapNow() {
  const target = await findTarget(await activeTabId());
  if (!target) return { ok: false, reason: 'no-session' };
  try {
    await chrome.tabs.sendMessage(target.tabId, { type: 'snap-now' }, { frameId: target.frameId });
    return { ok: true };
  } catch {
    await putSession(target.tabId, target.frameId, null);
    return { ok: false, reason: 'no-session' };
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'snap-now') snapNow();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'session-status' && sender.tab) {
    putSession(sender.tab.id, sender.frameId || 0, msg.status);
    return false;
  }
  if (msg.type === 'get-target') {
    findTarget(msg.activeTabId).then((t) => sendResponse(t));
    return true;
  }
  if (msg.type === 'snap-now') {
    snapNow().then(sendResponse);
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queue = queue.then(async () => {
    const sessions = await getSessions();
    let changed = false;
    for (const [id, s] of Object.entries(sessions)) if (s.tabId === tabId) { delete sessions[id]; changed = true; }
    if (changed) await chrome.storage.session.set({ [KEY]: sessions });
  }).catch(() => {});
});
