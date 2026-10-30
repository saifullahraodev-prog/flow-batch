const FLOW_URL = 'https://flow.google.com/';
const FLOW_PREFIXES = ['https://flow.google.com/', 'https://labs.google/fx/'];

// Toolbar icon: toggle the panel on a Flow tab, otherwise open Flow.
// (Guarded so the rest of the background script still runs if the toolbar
// API is unavailable – the panel itself is added by the content script.)
chrome.action?.onClicked.addListener((tab) => {
  if (tab.id && tab.url && FLOW_PREFIXES.some((p) => tab.url.startsWith(p))) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
  } else {
    chrome.tabs.create({ url: FLOW_URL });
  }
});

// ---------- real (trusted) input via the Chrome DevTools protocol ----------
// Flow ignores clicks/keys created by page scripts, so we send them the same
// way Chrome's own automation does. Chrome shows a "started debugging" bar
// while this is attached.

const attached = new Set();

chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId);
  chooser.delete(source.tabId);
});

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(String(e))) throw e;
  }
  attached.add(tabId);
}

const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

async function trustedClick(tabId, x, y) {
  await ensureAttached(tabId);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
};

async function trustedKey(tabId, name) {
  await ensureAttached(tabId);
  const { text, ...key } = KEYS[name];
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...(text ? { text } : {}), ...key });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

// ---------- reference images: answer Flow's "choose file" dialog ourselves ----------
// While armed, Chrome doesn't show the Windows file dialog; instead we get the
// <input type=file> Flow opened and put the reference image(s) into it.

const chooser = new Map(); // tabId -> { refs, promise, finish }

const SET_FILES_FN = `function (refs) {
  const dt = new DataTransfer();
  for (const r of refs) {
    const comma = r.dataUrl.indexOf(',');
    const mime = r.dataUrl.slice(5, r.dataUrl.indexOf(';'));
    const bin = atob(r.dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], r.name, { type: mime }));
  }
  this.files = dt.files;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.files.length;
}`;

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== 'Page.fileChooserOpened') return;
  const entry = chooser.get(source.tabId);
  if (!entry) return;
  try {
    const { object } = await cdp(source.tabId, 'DOM.resolveNode', { backendNodeId: params.backendNodeId });
    const res = await cdp(source.tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: SET_FILES_FN,
      arguments: [{ value: entry.refs }],
      returnByValue: true
    });
    entry.finish({ ok: true, count: res.result && res.result.value });
  } catch (e) {
    entry.finish({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

async function armFileChooser(tabId, refs) {
  await ensureAttached(tabId);
  await cdp(tabId, 'Page.enable');
  await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
  let finish;
  const promise = new Promise((r) => (finish = r));
  chooser.set(tabId, { refs, promise, finish });
}

async function awaitFileChooser(tabId, ms) {
  const entry = chooser.get(tabId);
  if (!entry) return { ok: false, error: 'not armed' };
  const timeout = new Promise((r) => setTimeout(() => r({ ok: false, error: 'no file dialog opened' }), ms));
  return Promise.race([entry.promise, timeout]);
}

async function disarmFileChooser(tabId) {
  chooser.delete(tabId);
  if (attached.has(tabId)) {
    await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

// ---------- fetching images for saving (no CORS limits here) ----------

async function fetchDataUrl(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

// ---------- message router ----------

async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'download': {
      const id = await chrome.downloads.download({
        url: msg.url,
        filename: msg.filename,
        conflictAction: msg.replace ? 'overwrite' : 'uniquify',
        saveAs: false
      });
      return { ok: true, id };
    }
    case 'fetchDataUrl':
      return { ok: true, dataUrl: await fetchDataUrl(msg.url) };
    case 'trustedClick':
      await trustedClick(tabId, msg.x, msg.y);
      return { ok: true };
    case 'trustedEnter':
      await trustedKey(tabId, 'Enter');
      return { ok: true };
    case 'trustedKey':
      await trustedKey(tabId, msg.key);
      return { ok: true };
    case 'armFileChooser':
      await armFileChooser(tabId, msg.refs);
      return { ok: true };
    case 'awaitFileChooser':
      return awaitFileChooser(tabId, msg.ms || 3000);
    case 'disarmFileChooser':
      await disarmFileChooser(tabId);
      return { ok: true };
    case 'detach':
      chooser.delete(tabId);
      if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.delete(tabId);
      return { ok: true };
  }
}

const TYPES = [
  'download', 'fetchDataUrl', 'trustedClick', 'trustedEnter', 'trustedKey',
  'armFileChooser', 'awaitFileChooser', 'disarmFileChooser', 'detach'
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !TYPES.includes(msg.type)) return;
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async response
});
