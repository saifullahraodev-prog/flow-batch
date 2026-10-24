(() => {
  if (window.__flowBatchLoaded) return;
  window.__flowBatchLoaded = true;

  const STORE_KEY = 'flowBatchState';
  const DEFAULTS = {
    splitMode: 'line',     // 'line' = one prompt per line, 'blank' = prompts separated by a blank line
    perPrompt: 1,          // images Flow makes per prompt (finishes early once this many appear)
    timeoutSec: 240,       // give up waiting on a prompt after this long
    stableSec: 10,         // or finish once new images stop appearing for this long
    delaySec: 5,           // pause between prompts
    autoDownload: true,
    folder: 'FlowBatch',   // only used if no save folder was chosen (Chrome Downloads fallback)
    promptSelector: '',    // optional CSS overrides if auto-detection fails
    buttonSelector: ''
  };

  const state = {
    prompts: [],           // { text, status, images }
    fileName: '',
    refs: [],              // reference images { name, dataUrl } – max 2, attached for every prompt
    runFolder: '',         // sub-folder for this run inside the chosen save folder
    refMethod: null,       // attach method that worked last time (tried first next time)
    settings: { ...DEFAULTS },
    running: false,
    paused: false,
    stopRequested: false
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function interruptibleSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !state.stopRequested) {
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  // ---------- persistence ----------

  function save() {
    chrome.storage.local.set({
      [STORE_KEY]: {
        prompts: state.prompts,
        fileName: state.fileName,
        settings: state.settings,
        refs: state.refs,
        runFolder: state.runFolder
      }
    });
  }

  async function load() {
    const data = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
    if (!data) return;
    state.settings = { ...DEFAULTS, ...(data.settings || {}) };
    state.fileName = data.fileName || '';
    state.refs = data.refs || [];
    state.runFolder = data.runFolder || '';
    state.prompts = (data.prompts || []).map((p) => ({
      ...p,
      status: p.status === 'running' ? 'pending' : p.status
    }));
  }

  // ---------- prompt file ----------

  function parsePrompts(text, mode) {
    const clean = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const parts =
      mode === 'blank'
        ? clean.split(/\n\s*\n/)
        : clean.split('\n').filter((l) => !l.trim().startsWith('#'));
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  // ---------- page automation ----------

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function findPromptBox() {
    const { promptSelector } = state.settings;
    if (promptSelector) return document.querySelector(promptSelector);
    const candidates = [
      ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')
    ].filter(isVisible);
    const hinted = candidates.find((el) =>
      /prompt|describe|create|imagine|generate|what do you want/i.test(
        (el.getAttribute('placeholder') || '') +
          ' ' +
          (el.getAttribute('aria-label') || '') +
          ' ' +
          (el.getAttribute('data-placeholder') || '')
      )
    );
    return hinted || candidates[0] || null;
  }

  function readText(el) {
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText || '';
  }

  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function setText(el, text) {
    el.focus();
    // 1st choice: real "typing" via insertText – fires the beforeinput/input events
    // that React and rich-text editors (Slate/Lexical) actually listen to.
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.select();
    else document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    if (norm(readText(el)) === norm(text)) return;

    // Fallback for plain React textareas: native value setter + input event.
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Labels / icon names the submit button might carry, and ones it never does.
  const BUTTON_RE = /start generation|\b(generate|send|submit)\b|arrow_forward|arrow_upward/i;
  const NOT_SUBMIT_RE = /\b(close|clear|cancel|remove|delete|add|agent)\b/i;

  function buttonLabel(b) {
    return [
      b.getAttribute('aria-label'),
      b.getAttribute('title'),
      b.getAttribute('data-tooltip'),
      b.getAttribute('data-testid'),
      b.innerText
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  const isDisabled = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';

  // The prompt bar = the closest ancestor of the box that also holds several buttons
  // (in Flow: "+", "Agent", the model chip, and the → submit arrow).
  function findComposer(box) {
    let node = box.parentElement;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const btns = [...node.querySelectorAll('button, [role="button"]')].filter(isVisible);
      if (btns.length >= 2) return { node, btns };
    }
    return null;
  }

  function findGenerateButton(box) {
    const { buttonSelector } = state.settings;
    if (buttonSelector) return document.querySelector(buttonSelector);
    const exact = liveCard(box).querySelector('button[aria-label="Start generation"]');
    if (exact) return exact;
    const composer = findComposer(box);
    if (!composer) return null;
    const btns = composer.btns.filter((b) => !NOT_SUBMIT_RE.test(buttonLabel(b)));
    if (!btns.length) return null;
    const labelled = btns.find((b) => BUTTON_RE.test(buttonLabel(b)));
    if (labelled) return labelled;
    // No telling label: the submit arrow is the right-most, lowest button in the bar.
    return btns.reduce((best, b) => {
      const r = b.getBoundingClientRect();
      const br = best.getBoundingClientRect();
      return r.right > br.right + 2 || (Math.abs(r.right - br.right) <= 2 && r.bottom > br.bottom) ? b : best;
    });
  }

  // Full pointer/mouse sequence – some UIs ignore a bare element.click().
  function humanClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerover', base));
    el.dispatchEvent(new PointerEvent('pointerenter', base));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus && el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  function pressEnter(el, extra = {}) {
    el.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, ...extra };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Real (trusted) click / Enter, sent by the background script via chrome.debugger.
  async function trusted(type, extra = {}) {
    try {
      const res = await chrome.runtime.sendMessage({ type, ...extra });
      if (res && !res.ok) log(`Real ${type === 'trustedClick' ? 'click' : 'Enter'} failed: ${res.error}`);
      return !!(res && res.ok);
    } catch (e) {
      log(`Real input failed: ${e.message}`);
      return false;
    }
  }

  async function trustedClickOn(el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    // A real click lands on whatever is on top – let it pass through our panel.
    host.style.pointerEvents = 'none';
    try {
      return await trusted('trustedClick', { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    } finally {
      host.style.pointerEvents = '';
    }
  }

  // Watch for anything Flow adds to the page outside the prompt bar and our panel
  // (a new generating tile, the empty-state disappearing, a progress spinner…).
  function watchPage(composerNode) {
    let changes = 0;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        for (const n of nodes) {
          if (n.nodeType !== 1 || n === host || host.contains(n)) continue;
          if (composerNode && (composerNode.contains(n) || composerNode.contains(m.target))) continue;
          if (/^(STYLE|SCRIPT|LINK|META)$/.test(n.nodeName)) continue;
          // Hover tooltips on the button are not a sign that generation started.
          if (n.getAttribute('role') === 'tooltip' || (n.isConnected && n.closest('[role="tooltip"]'))) continue;
          changes++;
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return { changes: () => changes, stop: () => obs.disconnect() };
  }

  async function waitSubmitted(box, text, watcher, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(250);
      const live = findPromptBox() || box;
      if (norm(readText(live)) !== norm(text)) return true; // prompt box was cleared
      if (watcher.changes() >= 2) return true;               // new content appeared
    }
    return false;
  }

  async function submitPrompt(box, text, index) {
    const composer = findComposer(box);
    const attempts = [
      ['real click on the generate button', async () => {
        const btn = findGenerateButton(box);
        return btn ? trustedClickOn(btn) : false;
      }],
      ['real Enter key', async () => {
        box.focus();
        return trusted('trustedEnter');
      }],
      ['scripted click', async () => {
        const btn = findGenerateButton(box);
        if (!btn) return false;
        humanClick(btn);
        return true;
      }],
      ['scripted Enter', async () => (pressEnter(box), true)]
    ];

    // Give Flow a moment to enable the button after the text arrives.
    for (let i = 0; i < 20; i++) {
      const btn = findGenerateButton(box);
      if (!btn || !isDisabled(btn)) break;
      await sleep(250);
    }

    for (const [how, act] of attempts) {
      if (state.stopRequested) return false;
      const watcher = watchPage(composer && composer.node);
      try {
        if (!(await act())) continue;
        // Wait a bit longer than Flow needs, so a slow start isn't mistaken for
        // a failure (which would submit the same prompt twice).
        if (await waitSubmitted(box, text, watcher, 6000)) {
          log(`#${index + 1} submitted (${how})`);
          return true;
        }
        log(`#${index + 1}: no response to ${how}, trying next method`);
      } finally {
        watcher.stop();
      }
    }
    return false;
  }

  // ---------- reference images ----------

  // The rounded prompt "card" around the box – where attached references show up.
  function findComposerCard(box) {
    let best = box;
    let node = box.parentElement;
    for (let d = 0; node && d < 8; d++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.6) break;
      best = node;
    }
    return best;
  }

  // Attached reference thumbnails (ignores tiny icons such as the model logo).
  function refThumbs(card) {
    return [...card.querySelectorAll('img')].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 28 && r.height >= 28 && isVisible(img);
    });
  }

  const liveCard = (box) => findComposerCard(findPromptBox() || box);

  function dataUrlToFile(ref) {
    const comma = ref.dataUrl.indexOf(',');
    const mime = ref.dataUrl.slice(5, ref.dataUrl.indexOf(';'));
    const bin = atob(ref.dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], ref.name, { type: mime });
  }

  function findMenuItem(re) {
    const els = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="button"], button, li, a, label')]
      .filter((el) => isVisible(el) && !host.contains(el))
      .filter((el) => {
        const t = norm(el.innerText || el.getAttribute('aria-label') || '');
        return t.length > 0 && t.length < 50 && re.test(t);
      });
    return els.find((el) => el.getAttribute('role') === 'menuitem') || els[0] || null;
  }

  async function waitFor(fn, ms, every = 300) {
    const end = Date.now() + ms;
    while (Date.now() < end && !state.stopRequested) {
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  // Wait until `target` thumbnails are in the prompt bar. If Flow pops up a
  // confirm/crop dialog (not the asset picker), confirm it.
  async function waitThumbs(box, target, ms) {
    const end = Date.now() + ms;
    let confirmed = false;
    while (Date.now() < end && !state.stopRequested) {
      await sleep(400);
      if (refThumbs(liveCard(box)).length >= target) return true;
      if (!confirmed) {
        for (const dlg of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
          if (!isVisible(dlg) || host.contains(dlg) || dlg === findAssetDialog()) continue;
          const btn = [...dlg.querySelectorAll('button, [role="button"]')]
            .filter(isVisible)
            .find((b) => /^(crop( and save)?|done|confirm|save|use|insert|ok)$/i.test(norm(b.innerText || b.getAttribute('aria-label') || '')));
          if (btn) {
            await trustedClickOn(btn);
            confirmed = true;
            break;
          }
        }
      }
    }
    return false;
  }

  // ---- Flow's own flow: "+" → "Add assets to the project" dialog → Upload media → click the asset ----

  function findPlusButton(card) {
    return (
      card.querySelector('button[aria-label="Add ingredients to the prompt box"]') ||
      [...card.querySelectorAll('button, [role="button"]')]
        .filter(isVisible)
        .find((b) => /ingredient|^\+$|\badd\b|add_2|add_circle|attach|add image|add media/i.test(buttonLabel(b)) && !BUTTON_RE.test(buttonLabel(b)) && !/^ingredient$/i.test(b.getAttribute('aria-label') || ''))
    );
  }

  function findAssetDialog() {
    return (
      [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => isVisible(d) && !host.contains(d) && (/asset/i.test(d.getAttribute('aria-label') || '') || d.querySelector('[aria-label="Asset list"], .asset-item'))
      ) || null
    );
  }

  function findAssetOption(dlg, name) {
    return [...dlg.querySelectorAll('[role="option"], .asset-item')].filter(isVisible).find((o) => norm(o.innerText || '').includes(name)) || null;
  }

  const isUploading = (o) => /uploading/i.test(o.textContent || '') || !!o.querySelector('[role="progressbar"], mat-spinner');

  async function closeAssetDialog() {
    const dlg = findAssetDialog();
    if (!dlg) return;
    const close = [...dlg.querySelectorAll('button')].find((b) => /^close$/i.test(b.getAttribute('aria-label') || ''));
    if (close) await trustedClickOn(close);
    else await trusted('trustedKey', { key: 'Escape' });
    await waitFor(() => !findAssetDialog(), 3000);
  }

  // Three ways to attach a file, tried in order (the last one that worked goes first):
  const ATTACH = {
    // 1. Flow's asset picker – re-uses the asset if it was uploaded before.
    async picker(box, ref) {
      const plus = findPlusButton(liveCard(box));
      if (!plus) return false;
      if (!findAssetDialog()) await trustedClickOn(plus);
      let dlg = await waitFor(findAssetDialog, 5000);
      if (!dlg) return false;

      let opt = findAssetOption(dlg, ref.name);
      if (!opt) {
        const up = [...dlg.querySelectorAll('button, [role="button"]')]
          .filter(isVisible)
          .find((b) => /upload/i.test(buttonLabel(b)));
        if (!up) {
          await closeAssetDialog();
          return false;
        }
        const armed = await chrome.runtime.sendMessage({ type: 'armFileChooser', refs: [ref] });
        if (!armed || !armed.ok) {
          await closeAssetDialog();
          return false;
        }
        try {
          await trustedClickOn(up);
          const res = await chrome.runtime.sendMessage({ type: 'awaitFileChooser', ms: 6000 });
          if (!res.ok) {
            log(`Upload: ${res.error}`);
            await closeAssetDialog();
            return false;
          }
        } finally {
          await chrome.runtime.sendMessage({ type: 'disarmFileChooser' });
        }
        log(`Uploading "${ref.name}" to the project…`);
      }

      // Wait until the asset is listed and finished uploading, then pick it.
      opt = await waitFor(() => {
        const d = findAssetDialog();
        const o = d && findAssetOption(d, ref.name);
        return o && !isUploading(o) ? o : null;
      }, 120000, 500);
      if (!opt) {
        await closeAssetDialog();
        return false;
      }
      await sleep(600);
      await trustedClickOn(opt);
      await waitFor(() => !findAssetDialog(), 3000);
      if (findAssetDialog()) await closeAssetDialog();
      return true;
    },
    // 1. An upload <input type=file> that belongs to the prompt bar.
    async input(box, ref) {
      const card = liveCard(box);
      const scope = (card.parentElement && card.parentElement.parentElement) || card;
      const input = scope.querySelector('input[type="file"]');
      if (!input) return false;
      const dt = new DataTransfer();
      dt.items.add(dataUrlToFile(ref));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    // 3. Generic menus: click "+", choose an Upload item – and we answer the file dialog.
    async menu(box, ref) {
      const plus = findPlusButton(liveCard(box));
      if (!plus) return false;
      const armed = await chrome.runtime.sendMessage({ type: 'armFileChooser', refs: [ref] });
      if (!armed || !armed.ok) return false;
      try {
        await trustedClickOn(plus);
        let res = await chrome.runtime.sendMessage({ type: 'awaitFileChooser', ms: 1500 });
        if (!res.ok) {
          await sleep(300);
          const item = findMenuItem(/upload|from (your )?(computer|device)|browse|choose (a )?file|add image/i);
          if (item) {
            await trustedClickOn(item);
            res = await chrome.runtime.sendMessage({ type: 'awaitFileChooser', ms: 4000 });
          }
        }
        if (!res.ok) await trusted('trustedKey', { key: 'Escape' }); // close any menu we opened
        return !!res.ok;
      } finally {
        await chrome.runtime.sendMessage({ type: 'disarmFileChooser' });
      }
    },
    // 3. Drag-and-drop the file onto the prompt bar.
    async drop(box, ref) {
      const target = findPromptBox() || box;
      const r = target.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.items.add(dataUrlToFile(ref));
      const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, opts));
      return true;
    }
  };

  async function ensureReferences(box, index) {
    if (!state.refs.length) return;
    let have = refThumbs(liveCard(box)).length;
    if (have >= state.refs.length) return; // still attached from the previous prompt

    for (const ref of state.refs.slice(have)) {
      const order = ['picker', 'input', 'menu', 'drop'];
      if (state.refMethod) order.sort((a, b) => (a === state.refMethod ? -1 : b === state.refMethod ? 1 : 0));
      let ok = false;
      for (const how of order) {
        if (state.stopRequested) return;
        let tried = false;
        try {
          tried = await ATTACH[how](box, ref);
        } catch (e) {
          log(`Reference attach (${how}) error: ${e.message}`);
        }
        if (tried && (await waitThumbs(box, have + 1, 20000))) {
          ok = true;
          state.refMethod = how;
          have++;
          log(`#${index + 1} reference "${ref.name}" attached`);
          break;
        }
      }
      if (!ok) throw new Error(`Could not attach reference image "${ref.name}" to Flow.`);
    }
    await sleep(1500); // let Flow finish processing the upload
  }

  function collectImages(skip) {
    const srcs = new Set();
    for (const img of document.querySelectorAll('img')) {
      if (skip && skip.contains(img)) continue;
      if (img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256) {
        const src = img.currentSrc || img.src;
        if (src) srcs.add(src);
      }
    }
    return [...srcs];
  }

  // Flow's settings chip reads e.g. "🍌 Nano Banana 2.1 crop_16_9 x2" – use its count.
  function flowImageCount() {
    const chip = document.querySelector('button[aria-label="Settings trigger"]');
    const m = chip && (chip.innerText || '').match(/\bx(\d{1,2})\b/);
    return m ? Number(m[1]) : 0;
  }

  async function runOne(index) {
    const p = state.prompts[index];
    let box = findPromptBox();
    if (!box) throw new Error('Prompt box not found – set a prompt selector under Advanced.');

    await ensureReferences(box, index);
    box = findPromptBox() || box;

    // Snapshot existing images (incl. the references) so only new results count.
    const refSrcs = refThumbs(liveCard(box)).map((i) => i.currentSrc || i.src);
    const before = new Set([...collectImages(), ...refSrcs]);
    setText(box, p.text);
    await sleep(800);

    if (!(await submitPrompt(box, p.text, index))) {
      throw new Error('Flow did not accept the prompt – use Advanced → Test detection, or set the button selector.');
    }

    const { stableSec, timeoutSec } = state.settings;
    const perPrompt = flowImageCount() || state.settings.perPrompt;
    const start = Date.now();
    let lastCount = 0;
    let lastChange = Date.now();
    while (!state.stopRequested) {
      await sleep(1000);
      const fresh = collectImages(liveCard(box)).filter((s) => !before.has(s));
      if (fresh.length !== lastCount) {
        lastCount = fresh.length;
        lastChange = Date.now();
        setRowNote(index, `${fresh.length} image(s)…`);
      }
      const quiet = Date.now() - lastChange;
      if (fresh.length >= perPrompt && quiet >= 2000) return { status: 'done', fresh };
      if (fresh.length > 0 && quiet >= stableSec * 1000) return { status: 'done', fresh };
      if (Date.now() - start > timeoutSec * 1000) {
        return { status: fresh.length ? 'done' : 'timeout', fresh };
      }
    }
    return { status: 'pending', fresh: [] };
  }

  // ---------- downloads ----------

  function slug(text) {
    return (
      text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'prompt'
    );
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function extFor(url, mime) {
    const m = (mime || '').match(/image\/(png|jpe?g|webp|gif)/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    const u = url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i);
    return u ? u[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  }

  // ---------- save folder: chosen once, then written to silently ----------

  const IDB = {
    db: null,
    open() {
      return (this.db ||= new Promise((res, rej) => {
        const r = indexedDB.open('flowBatch', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    },
    async get(k) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const r = db.transaction('kv').objectStore('kv').get(k);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async set(k, v) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
  };

  const canPickFolder = typeof window.showDirectoryPicker === 'function';
  let dirHandle = null;

  async function chooseFolder() {
    // Must be called from a click.
    const h = await window.showDirectoryPicker({ id: 'flowbatch', mode: 'readwrite' });
    dirHandle = h;
    await IDB.set('dir', h);
    log(`Images will be saved in folder "${h.name}"`);
    renderFolder();
    return h;
  }

  // interactive = called from a click, so Chrome may re-ask for permission once.
  async function folderReady(interactive) {
    if (!dirHandle) dirHandle = await IDB.get('dir').catch(() => null);
    if (!dirHandle) return null;
    let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && interactive) perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted' ? dirHandle : null;
  }

  async function renderFolder() {
    const el = $('folderName');
    if (!canPickFolder) {
      el.textContent = `Chrome Downloads/${state.settings.folder}`;
      $('folderPick').hidden = true;
      return;
    }
    if (!dirHandle) dirHandle = await IDB.get('dir').catch(() => null);
    el.textContent = dirHandle ? `📁 ${dirHandle.name}` : 'not chosen yet';
  }

  async function getBlob(src) {
    try {
      const r = await fetch(src, { credentials: 'include' });
      if (r.ok) return await r.blob();
    } catch {
      /* blocked by CORS – fetch through the background instead */
    }
    const res = await chrome.runtime.sendMessage({ type: 'fetchDataUrl', url: src });
    if (!res || !res.ok) throw new Error((res && res.error) || 'could not fetch image');
    return (await fetch(res.dataUrl)).blob();
  }

  async function saveImages(index, srcs) {
    const base = `${String(index + 1).padStart(3, '0')}_${slug(state.prompts[index].text)}`;
    const runDir = state.runFolder || 'FlowBatch';
    let target = null;
    const dir = await folderReady(false);
    if (dir) {
      try {
        target = await dir.getDirectoryHandle(runDir, { create: true });
      } catch (e) {
        log(`Folder error: ${e.message} – using Chrome Downloads instead`);
      }
    }
    let saved = 0;
    for (let k = 0; k < srcs.length; k++) {
      try {
        const blob = await getBlob(srcs[k]);
        const name = `${base}_${k + 1}.${extFor(srcs[k], blob.type)}`;
        if (target) {
          const fh = await target.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(blob);
          await w.close();
        } else {
          const folder = state.settings.folder.replace(/[\\:*?"<>|]/g, '_');
          const res = await chrome.runtime.sendMessage({
            type: 'download',
            url: await blobToDataUrl(blob),
            filename: `${folder}/${runDir}/${name}`
          });
          if (!res || !res.ok) throw new Error((res && res.error) || 'download failed');
        }
        saved++;
      } catch (e) {
        log(`Save failed: ${e.message}`);
      }
    }
    return saved;
  }

  function newRunFolder() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = (state.fileName || 'prompts').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
    return `${name}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ---------- run loop ----------

  async function start() {
    if (state.running || !state.prompts.length) return;
    state.running = true;
    state.paused = false;
    state.stopRequested = false;
    // New run (nothing done yet) → new sub-folder; Resume keeps the old one.
    if (!state.runFolder || !state.prompts.some((p) => p.status === 'done')) {
      state.runFolder = newRunFolder();
      save();
    }
    render();
    log(`Started – saving to ${dirHandle ? dirHandle.name : 'Chrome Downloads/' + state.settings.folder}/${state.runFolder}`);
    if (state.refs.length) log(`Using ${state.refs.length} reference image(s) for every prompt`);

    for (let i = 0; i < state.prompts.length && !state.stopRequested; i++) {
      const p = state.prompts[i];
      if (p.status === 'done') continue;
      while (state.paused && !state.stopRequested) await sleep(300);
      if (state.stopRequested) break;

      p.status = 'running';
      render();
      try {
        const { status, fresh } = await runOne(i);
        p.status = status;
        p.images = fresh.length;
        if (status === 'timeout') log(`#${i + 1} timed out with no images`);
        if (fresh.length && state.settings.autoDownload) {
          const n = await saveImages(i, fresh);
          log(`#${i + 1} done – ${fresh.length} image(s), ${n} saved`);
        } else if (fresh.length) {
          log(`#${i + 1} done – ${fresh.length} image(s)`);
        }
      } catch (e) {
        p.status = 'error';
        log(`#${i + 1} error: ${e.message}`);
        // Without the references every result would be wrong – stop instead of wasting credits.
        if (/reference image/i.test(e.message)) {
          state.stopRequested = true;
          log('Stopped so no credits are wasted. Check the reference images and press Resume.');
        }
      }
      save();
      render();
      if (i < state.prompts.length - 1) await interruptibleSleep(state.settings.delaySec * 1000);
    }

    state.running = false;
    state.paused = false;
    chrome.runtime.sendMessage({ type: 'detach' }).catch(() => {}); // removes the "debugging" bar
    log(state.stopRequested ? 'Stopped' : 'Finished all prompts');
    state.stopRequested = false;
    render();
  }

  // ---------- panel UI (shadow DOM so Flow's styles don't clash) ----------

  const host = document.createElement('div');
  host.id = 'flow-batch-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: 80vh;
        display: flex; flex-direction: column; z-index: 2147483647;
        font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #e8eaed;
        background: #202124; border: 1px solid #3c4043; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #292a2d; }
      .head b { flex: 1; font-size: 14px; }
      .body { padding: 10px 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
      .collapsed .body { display: none; }
      button { font: inherit; color: #e8eaed; background: #3c4043; border: 0; border-radius: 8px;
        padding: 6px 10px; cursor: pointer; }
      button:hover:not(:disabled) { background: #4a4d51; }
      button:disabled { opacity: .45; cursor: default; }
      button.primary { background: #8ab4f8; color: #202124; font-weight: 600; }
      button.icon { padding: 2px 8px; }
      .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .grid { display: grid; grid-template-columns: 1fr 70px; gap: 4px 8px; align-items: center; }
      input[type=number], input[type=text], select { font: inherit; color: #e8eaed; background: #303134;
        border: 1px solid #5f6368; border-radius: 6px; padding: 3px 6px; width: 100%; box-sizing: border-box; }
      .muted { color: #9aa0a6; font-size: 12px; }
      .list { border: 1px solid #3c4043; border-radius: 8px; max-height: 200px; overflow: auto; }
      .item { display: grid; grid-template-columns: 22px 30px 1fr; gap: 4px; padding: 4px 6px;
        border-bottom: 1px solid #303134; }
      .item:last-child { border-bottom: 0; }
      .item .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .item.running { background: #283142; }
      .item .note { grid-column: 3; color: #9aa0a6; font-size: 11px; }
      .bar { height: 6px; background: #3c4043; border-radius: 3px; overflow: hidden; }
      .bar > div { height: 100%; background: #8ab4f8; width: 0; transition: width .3s; }
      .log { font: 11px/1.4 ui-monospace, Consolas, monospace; background: #171717; border-radius: 6px;
        padding: 6px; max-height: 110px; overflow: auto; white-space: pre-wrap; color: #bdc1c6; }
      details summary { cursor: pointer; color: #9aa0a6; }
      label.chk { display: flex; gap: 6px; align-items: center; }
      .refs { display: flex; gap: 8px; }
      .refs:empty { display: none; }
      .ref { position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden;
        border: 1px solid #5f6368; }
      .ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .ref button { position: absolute; top: 2px; right: 2px; padding: 0 5px; font-size: 12px;
        line-height: 16px; border-radius: 8px; background: rgba(0,0,0,.7); }
    </style>
    <div class="panel">
      <div class="head">
        <b>Flow Batch</b>
        <button class="icon" id="min" title="Minimise">–</button>
        <button class="icon" id="close" title="Hide (click the toolbar icon to show again)">×</button>
      </div>
      <div class="body">
        <div class="row">
          <button id="pick">Load .txt file…</button>
          <select id="splitMode" style="width:auto">
            <option value="line">One prompt per line</option>
            <option value="blank">Separated by blank line</option>
          </select>
          <input type="file" id="file" accept=".txt,text/plain" hidden>
        </div>
        <div class="muted" id="fileInfo">No file loaded.</div>
        <div class="row">
          <button id="refPick">Reference images…</button>
          <span class="muted" id="refInfo">optional · max 2 · used for every prompt</span>
          <input type="file" id="refFile" accept="image/*" multiple hidden>
        </div>
        <div class="refs" id="refs"></div>
        <div class="row">
          <button id="folderPick">Save folder…</button>
          <span class="muted" id="folderName"></span>
        </div>
        <div class="bar"><div id="bar"></div></div>
        <div class="list" id="list"></div>
        <div class="row">
          <button class="primary" id="start">Start</button>
          <button id="pause">Pause</button>
          <button id="stop">Stop</button>
          <button id="reset" title="Mark every prompt as not done">Reset</button>
        </div>
        <details>
          <summary>Settings</summary>
          <div class="grid" style="margin-top:6px">
            <span>Images per prompt</span><input type="number" min="1" max="8" data-k="perPrompt">
            <span>Wait between prompts (s)</span><input type="number" min="0" data-k="delaySec">
            <span>Done when no new image for (s)</span><input type="number" min="2" data-k="stableSec">
            <span>Give up after (s)</span><input type="number" min="30" data-k="timeoutSec">
          </div>
          <label class="chk" style="margin-top:6px"><input type="checkbox" data-k="autoDownload"> Download images automatically</label>
          <div class="grid" style="grid-template-columns: 1fr 150px; margin-top:4px">
            <span>Fallback Downloads sub-folder</span><input type="text" data-k="folder">
          </div>
        </details>
        <details>
          <summary>Advanced (only if auto-detect fails)</summary>
          <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">
            <span class="muted">Prompt box CSS selector</span><input type="text" data-k="promptSelector" placeholder="auto">
            <span class="muted">Generate button CSS selector</span><input type="text" data-k="buttonSelector" placeholder="auto">
            <button id="test">Test detection</button>
          </div>
        </details>
        <div class="log" id="log"></div>
      </div>
    </div>`;

  const $ = (id) => root.getElementById(id);
  const ICON = { pending: '○', running: '⏳', done: '✅', timeout: '⚠️', error: '❌' };

  function log(msg) {
    const el = $('log');
    const t = new Date().toLocaleTimeString();
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function setRowNote(index, text) {
    const note = root.querySelector(`.item[data-i="${index}"] .note`);
    if (note) note.textContent = text;
  }

  function render() {
    const list = $('list');
    list.textContent = '';
    state.prompts.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'item' + (p.status === 'running' ? ' running' : '');
      row.dataset.i = i;
      row.title = p.text;
      const icon = document.createElement('span');
      icon.textContent = ICON[p.status] || '○';
      const num = document.createElement('span');
      num.className = 'muted';
      num.textContent = `#${i + 1}`;
      const text = document.createElement('span');
      text.className = 't';
      text.textContent = p.text;
      const note = document.createElement('span');
      note.className = 'note';
      if (p.status === 'done') note.textContent = `${p.images} image(s)`;
      row.append(icon, num, text, note);
      list.append(row);
    });
    const running = list.querySelector('.running');
    if (running) running.scrollIntoView({ block: 'nearest' });

    const done = state.prompts.filter((p) => p.status === 'done').length;
    const total = state.prompts.length;
    $('bar').style.width = total ? `${(done / total) * 100}%` : '0';
    $('fileInfo').textContent = total
      ? `${state.fileName || 'Prompts'} – ${total} prompts, ${done} done`
      : 'No file loaded.';

    $('start').disabled = state.running || !total;
    $('start').textContent = done > 0 && done < total ? 'Resume' : 'Start';
    $('pause').disabled = !state.running;
    $('pause').textContent = state.paused ? 'Continue' : 'Pause';
    $('stop').disabled = !state.running;
    $('reset').disabled = state.running || !total;
    $('pick').disabled = state.running;
    $('splitMode').value = state.settings.splitMode;
    $('refPick').disabled = state.running || state.refs.length >= 2;
    $('folderPick').disabled = state.running;

    const refs = $('refs');
    refs.textContent = '';
    state.refs.forEach((r, i) => {
      const box = document.createElement('div');
      box.className = 'ref';
      box.title = r.name;
      const img = document.createElement('img');
      img.src = r.dataUrl;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove';
      x.disabled = state.running;
      x.onclick = () => {
        state.refs.splice(i, 1);
        save();
        render();
      };
      box.append(img, x);
      refs.append(box);
    });

    for (const input of root.querySelectorAll('[data-k]')) {
      const v = state.settings[input.dataset.k];
      if (input.type === 'checkbox') input.checked = !!v;
      else if (root.activeElement !== input) input.value = v;
    }
  }

  // ---------- wiring ----------

  let rawFileText = '';

  function loadPrompts() {
    state.prompts = parsePrompts(rawFileText, state.settings.splitMode).map((text) => ({
      text,
      status: 'pending',
      images: 0
    }));
    save();
    render();
    log(`Loaded ${state.prompts.length} prompts`);
  }

  $('pick').onclick = () => $('file').click();
  $('file').onchange = async () => {
    // Keep a direct reference: inside shadow DOM, e.target is null after an await.
    const input = $('file');
    const f = input.files[0];
    if (!f) return;
    rawFileText = await f.text();
    state.fileName = f.name;
    loadPrompts();
    input.value = ''; // so picking the same file again still triggers a reload
  };
  $('splitMode').onchange = (e) => {
    state.settings.splitMode = e.target.value;
    if (rawFileText) loadPrompts();
    else save();
  };
  $('refPick').onclick = () => $('refFile').click();
  $('refFile').onchange = async () => {
    const input = $('refFile');
    const files = [...input.files].filter((f) => f.type.startsWith('image/'));
    const room = 2 - state.refs.length;
    if (files.length > room) log(`Only 2 reference images allowed – added the first ${room}`);
    for (const f of files.slice(0, room)) {
      // Names must be unique – the extension finds the uploaded asset in Flow by its name.
      let name = f.name;
      while (state.refs.some((r) => r.name === name)) name = name.replace(/(\.[^.]+)?$/, (ext) => `-2${ext}`);
      state.refs.push({ name, dataUrl: await blobToDataUrl(f) });
    }
    input.value = '';
    save();
    render();
  };
  $('folderPick').onclick = () => chooseFolder().catch((e) => e.name !== 'AbortError' && log(`Folder: ${e.message}`));

  $('start').onclick = async () => {
    // This click is the last thing you do: settle the save folder now so
    // nothing needs you during the run.
    if (state.settings.autoDownload && canPickFolder) {
      try {
        if (!(await folderReady(true))) await chooseFolder();
      } catch (e) {
        log(`No save folder chosen – using Chrome Downloads/${state.settings.folder} instead`);
      }
    }
    start();
  };
  $('pause').onclick = () => {
    state.paused = !state.paused;
    log(state.paused ? 'Paused – will hold after the current prompt' : 'Continuing');
    render();
  };
  $('stop').onclick = () => {
    state.stopRequested = true;
    log('Stopping…');
  };
  $('reset').onclick = () => {
    state.prompts.forEach((p) => {
      p.status = 'pending';
      p.images = 0;
    });
    save();
    render();
  };
  $('test').onclick = () => {
    const box = findPromptBox();
    const btn = box && findGenerateButton(box);
    log(`Prompt box: ${box ? box.tagName.toLowerCase() + ' ✓' : 'NOT FOUND'}`);
    log(`Generate button: ${btn ? `"${buttonLabel(btn) || btn.tagName}" ✓` : 'NOT FOUND (will press Enter)'}`);
    if (btn) log(`Button HTML: ${btn.outerHTML.replace(/\s+/g, ' ').slice(0, 200)}`);
    for (const el of [box, btn]) {
      if (!el) continue;
      const old = el.style.outline;
      el.style.outline = '3px solid #f28b82';
      setTimeout(() => (el.style.outline = old), 2500);
    }
  };
  for (const input of root.querySelectorAll('[data-k]')) {
    input.onchange = () => {
      const k = input.dataset.k;
      state.settings[k] =
        input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) || DEFAULTS[k] : input.value.trim();
      save();
    };
  }
  $('min').onclick = () => {
    const panel = root.querySelector('.panel');
    panel.classList.toggle('collapsed');
    $('min').textContent = panel.classList.contains('collapsed') ? '+' : '–';
  };
  $('close').onclick = () => (host.style.display = 'none');

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle') host.style.display = host.style.display === 'none' ? '' : 'none';
  });

  document.documentElement.appendChild(host);
  load().then(() => {
    render();
    renderFolder();
    if (state.prompts.length) log(`Restored ${state.prompts.length} prompts from last session`);
  });
})();
