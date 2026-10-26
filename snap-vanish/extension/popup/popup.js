// Snap Vanish — popup.
const DEFAULTS = globalThis.SNAP_VANISH_DEFAULTS;
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let target = null;

const save = (patch) => {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set(patch);
  renderStatus();
};

function renderSettings() {
  $('enabled').checked = settings.enabled;
  $('sensitivity').value = settings.sensitivity;
  $('sensitivityOut').textContent = `${settings.sensitivity}/10`;
  $('duration').value = settings.duration;
  $('durationOut').textContent = `${Number(settings.duration).toFixed(1)} s`;
  for (const b of $('direction').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.dir === settings.direction));
  }
  $('muteMic').checked = settings.muteMic;
  $('requireSound').checked = settings.requireSound;
  document.querySelector('.settings').style.opacity = settings.enabled ? '1' : '.55';
}

function setStatus(tone, title, detail = '') {
  $('status').dataset.tone = tone;
  $('statusTitle').textContent = title;
  $('statusDetail').textContent = detail;
}

let supported = false;
let activeTabId = -1;

function renderStatus() {
  const s = target && target.status;
  const otherTab = target && target.tabId !== activeTabId;
  const where = otherTab ? ' (in another tab)' : '';
  const snap = $('snap');
  snap.disabled = true;
  $('snapLabel').textContent = 'Snap now';

  if (!settings.enabled) {
    setStatus('idle', 'Switched off', 'Turn it on, then turn your camera off and on again in the meeting.');
    return;
  }
  if (!s) {
    if (supported) setStatus('idle', 'Waiting for your camera', 'Turn your camera on in the meeting. Already on? Turn it off and on once.');
    else setStatus('idle', 'Open a video call', 'Works on Google Meet, Microsoft Teams and Zoom in the browser. Already in one? Reload that tab once.');
    return;
  }
  if (s.error) {
    setStatus('bad', 'Couldn’t start', s.error);
    return;
  }
  if (!s.enabled) {
    setStatus('idle', 'Camera started while switched off', 'Turn your camera off and on in the meeting to activate.');
    return;
  }
  if (!s.ready) {
    setStatus('busy', `Loading AI models…${where}`, 'Hand tracking, background separation and room fill run locally.');
    return;
  }
  snap.disabled = s.state === 'vanishing' || s.state === 'appearing';
  if (s.state === 'vanished') {
    setStatus('gone', `You’ve vanished 👻${where}`, s.micMuted ? 'Your mic is muted. Snap again to come back.' : 'Snap again to come back.');
    $('snapLabel').textContent = 'Snap back';
  } else if (s.state === 'vanishing') {
    setStatus('gone', 'Turning to dust…', '');
  } else if (s.state === 'appearing') {
    setStatus('busy', 'Reassembling…', '');
  } else {
    const ear = s.micListening ? 'Listening for the snap sound too.' : 'No mic — using hand tracking only.';
    const room = s.inpaint === 'ready' ? '' : s.inpaint === 'loading' ? ' Room AI loading…' : '';
    setStatus('ok', `Ready — snap your fingers${where}`, `${ear}${room}`);
  }
}

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab ? tab.id : -1;
    supported = false;
    if (tab) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' }, { frameId: 0 });
        supported = !!(r && r.ok);
      } catch { /* no content script here */ }
    }
    target = await chrome.runtime.sendMessage({ type: 'get-target', activeTabId });
  } catch {
    target = null;
  }
  renderStatus();
}

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  renderSettings();

  $('enabled').addEventListener('change', (e) => { save({ enabled: e.target.checked }); renderSettings(); });
  $('sensitivity').addEventListener('input', (e) => { save({ sensitivity: Number(e.target.value) }); renderSettings(); });
  $('duration').addEventListener('input', (e) => { save({ duration: Number(e.target.value) }); renderSettings(); });
  $('muteMic').addEventListener('change', (e) => save({ muteMic: e.target.checked }));
  $('requireSound').addEventListener('change', (e) => save({ requireSound: e.target.checked }));
  for (const b of $('direction').querySelectorAll('button')) {
    b.addEventListener('click', () => { save({ direction: b.dataset.dir }); renderSettings(); });
  }

  $('snap').addEventListener('click', async () => {
    $('snap').disabled = true;
    await chrome.runtime.sendMessage({ type: 'snap-now' }).catch(() => {});
    setTimeout(refresh, 150);
  });

  $('changeShortcut').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  chrome.commands.getAll().then((cmds) => {
    const c = cmds.find((x) => x.name === 'snap-now');
    $('shortcut').textContent = (c && c.shortcut) || 'not set';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') refresh();
  });

  await refresh();
  setInterval(refresh, 1500);
}

init();
