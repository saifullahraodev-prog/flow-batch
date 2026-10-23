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

// Content script asks us to save an image (http(s) or data: URL).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    chrome.downloads
      .download({
        url: msg.url,
        filename: msg.filename,
        conflictAction: 'uniquify',
        saveAs: false
      })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // keep the channel open for the async response
  }
});
