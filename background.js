const FLOW_URL = 'https://flow.google.com/';
const FLOW_PREFIXES = ['https://flow.google.com/', 'https://labs.google/fx/'];

// Toolbar icon: toggle the panel on a Flow tab, otherwise open Flow.
chrome.action.onClicked.addListener((tab) => {
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

chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));

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

async function trustedEnter(tabId) {
  await ensureAttached(tabId);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'download': {
      const id = await chrome.downloads.download({
        url: msg.url,
        filename: msg.filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
      return { ok: true, id };
    }
    case 'trustedClick':
      await trustedClick(tabId, msg.x, msg.y);
      return { ok: true };
    case 'trustedEnter':
      await trustedEnter(tabId);
      return { ok: true };
    case 'detach':
      if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.delete(tabId);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !['download', 'trustedClick', 'trustedEnter', 'detach'].includes(msg.type)) return;
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async response
});
