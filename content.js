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
    folder: 'FlowBatch',   // sub-folder inside Chrome's Downloads folder
    promptSelector: '',    // optional CSS overrides if auto-detection fails
    buttonSelector: ''
  };

  const state = {
    prompts: [],           // { text, status, images }
    fileName: '',
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
      [STORE_KEY]: { prompts: state.prompts, fileName: state.fileName, settings: state.settings }
    });
  }

  async function load() {
    const data = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
    if (!data) return;
    state.settings = { ...DEFAULTS, ...(data.settings || {}) };
    state.fileName = data.fileName || '';
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

  // Labels / icon names the submit button might carry.
  const BUTTON_RE = /\b(create|generate|send|submit|run)\b|arrow_forward|arrow_upward|north|send/i;

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
    const composer = findComposer(box);
    if (!composer) return null;
    const { btns } = composer;
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

  // Signals that Flow accepted the prompt: box cleared, or new tiles/progress appeared.
  function pageSignature() {
    return document.querySelectorAll('img, video, [role="progressbar"], [aria-busy="true"]').length;
  }

  async function waitSubmitted(box, text, sigBefore, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(250);
      const live = findPromptBox() || box;
      if (norm(readText(live)) !== norm(text)) return true;
      if (pageSignature() !== sigBefore) return true;
    }
    return false;
  }

  async function submitPrompt(box, text, index) {
    const attempts = [
      ['clicked the generate button', () => {
        const btn = findGenerateButton(box);
        if (!btn) return false;
        humanClick(btn);
        return true;
      }],
      ['pressed Enter', () => (pressEnter(box), true)],
      ['pressed Ctrl+Enter', () => (pressEnter(box, { ctrlKey: true }), true)],
      ['clicked the generate button (plain click)', () => {
        const btn = findGenerateButton(box);
        if (!btn) return false;
        btn.click();
        return true;
      }]
    ];

    // Give Flow a moment to enable the button after the text arrives.
    for (let i = 0; i < 20; i++) {
      const btn = findGenerateButton(box);
      if (!btn || !isDisabled(btn)) break;
      await sleep(250);
    }

    for (const [how, act] of attempts) {
      const sig = pageSignature();
      if (!act()) continue;
      if (await waitSubmitted(box, text, sig, 4000)) {
        log(`#${index + 1} submitted (${how})`);
        return true;
      }
    }
    return false;
  }

  function collectImages() {
    const srcs = new Set();
    for (const img of document.querySelectorAll('img')) {
      if (img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256) {
        const src = img.currentSrc || img.src;
        if (src) srcs.add(src);
      }
    }
    return [...srcs];
  }

  async function runOne(index) {
    const p = state.prompts[index];
    const box = findPromptBox();
    if (!box) throw new Error('Prompt box not found – set a prompt selector under Advanced.');

    const before = new Set(collectImages());
    setText(box, p.text);
    await sleep(800);

    if (!(await submitPrompt(box, p.text, index))) {
      throw new Error('Flow did not accept the prompt – use Advanced → Test detection, or set the button selector.');
    }

    const { perPrompt, stableSec, timeoutSec } = state.settings;
    const start = Date.now();
    let lastCount = 0;
    let lastChange = Date.now();
    while (!state.stopRequested) {
      await sleep(1000);
      const fresh = collectImages().filter((s) => !before.has(s));
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

  async function downloadImages(index, srcs) {
    const prefix = `${state.settings.folder.replace(/[\\:*?"<>|]/g, '_')}/${String(index + 1).padStart(3, '0')}_${slug(state.prompts[index].text)}`;
    let saved = 0;
    for (let k = 0; k < srcs.length; k++) {
      let url = srcs[k];
      let mime = '';
      try {
        if (url.startsWith('blob:')) {
          const blob = await (await fetch(url)).blob();
          mime = blob.type;
          url = await blobToDataUrl(blob);
        } else if (url.startsWith('data:')) {
          mime = url.slice(5, url.indexOf(';'));
        }
        const res = await chrome.runtime.sendMessage({
          type: 'download',
          url,
          filename: `${prefix}_${k + 1}.${extFor(srcs[k], mime)}`
        });
        if (res && res.ok) saved++;
        else log(`Download failed: ${res && res.error}`);
      } catch (e) {
        log(`Download failed: ${e.message}`);
      }
    }
    return saved;
  }

  // ---------- run loop ----------

  async function start() {
    if (state.running || !state.prompts.length) return;
    state.running = true;
    state.paused = false;
    state.stopRequested = false;
    render();
    log('Started');

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
          const n = await downloadImages(i, fresh);
          log(`#${i + 1} done – ${fresh.length} image(s), ${n} saved`);
        } else if (fresh.length) {
          log(`#${i + 1} done – ${fresh.length} image(s)`);
        }
      } catch (e) {
        p.status = 'error';
        log(`#${i + 1} error: ${e.message}`);
      }
      save();
      render();
      if (i < state.prompts.length - 1) await interruptibleSleep(state.settings.delaySec * 1000);
    }

    state.running = false;
    state.paused = false;
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
            <span>Downloads sub-folder</span><input type="text" data-k="folder">
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
  $('start').onclick = () => start();
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
    if (state.prompts.length) log(`Restored ${state.prompts.length} prompts from last session`);
  });
})();
