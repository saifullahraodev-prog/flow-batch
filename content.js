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
    style: '',             // added in front of every prompt, e.g. "2D stickman cartoon, flat colours"
    promptSelector: '',    // optional CSS overrides if auto-detection fails
    buttonSelector: '',
    retries: 1,            // try a failed prompt again this many times, right away
    graceSec: 30,          // after a timeout, keep watching this long for a late image
    autoRecover: true      // Flow keeps failing → pause, reload the page, continue
  };

  const state = {
    prompts: [],           // { text, status, images }
    fileName: '',
    refs: [],              // reference images { name, dataUrl } – max 2, attached for every prompt
    runFolder: '',         // sub-folder for this run inside the chosen save folder
    refMethod: null,       // attach method that worked last time (tried first next time)
    // Scene Builder: plain script → scenes table (narration, picture, chapter)
    builder: { script: '', mode: 'medium', name: 'my-video', rows: [] },
    settings: { ...DEFAULTS },
    claimed: [],           // keys of images already seen or given to a scene – never counted again
    genTimes: [],          // seconds from submit to first image (recent prompts)
    recoverRound: 0,       // automatic recoveries in a row
    resumeAfterReload: false,
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
        runFolder: state.runFolder,
        builder: state.builder,
        claimed: state.claimed.slice(-5000),
        genTimes: state.genTimes,
        recoverRound: state.recoverRound,
        resumeAfterReload: state.resumeAfterReload
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
    if (data.builder) state.builder = { ...state.builder, ...data.builder };
    state.claimed = data.claimed || [];
    state.genTimes = data.genTimes || [];
    state.recoverRound = data.recoverRound || 0;
    state.resumeAfterReload = !!data.resumeAfterReload;
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

  // Scenes from the loaded file. A "## Chapter title" line names the chapter that
  // starts at the next scene (kept in scenes.txt for Make Video's YouTube chapters).
  // A line in brackets – "(narration)" – is the narration of the prompt below it.
  const NARRATION_LINE = /^\(([\s\S]*)\)$/;

  function withNarration(scene, said) {
    if (said.length && !scene.narration) scene.narration = said.join(' ').replace(/\|/g, '/');
    return scene;
  }

  function parseScenes(text, mode) {
    if (mode === 'blank') {
      return parsePrompts(text, mode).map((block) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        const said = [];
        while (lines.length > 1 && NARRATION_LINE.test(lines[0])) said.push(lines.shift().match(NARRATION_LINE)[1].trim());
        return { ...withNarration(splitScene(lines.join(' ')), said), chapter: '' };
      });
    }
    const scenes = [];
    let chapter = '';
    let said = [];
    for (const raw of text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^##\s*(.+)$/);
      if (m) {
        chapter = m[1].trim();
        continue;
      }
      if (line.startsWith('#')) continue;
      const n = line.match(NARRATION_LINE);
      if (n) {
        said.push(n[1].trim());
        continue;
      }
      scenes.push({ ...withNarration(splitScene(line), said), chapter });
      chapter = '';
      said = [];
    }
    if (said.length) scenes.push({ ...withNarration({ text: '', narration: '' }, said), chapter });
    return scenes;
  }

  // ---------- Scene Builder: plain script → scenes ----------

  const SCENE_WORDS = { short: 12, medium: 22, long: 35 }; // target words per scene (~2.5 words/s)
  const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc|Capt|Lt|Col|Gen|Mt|No|Fig|approx|e\.g|i\.e|U\.S|U\.K)\.$/i;
  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

  function sentencesOf(paragraph) {
    const out = [];
    for (const piece of paragraph.split(/(?<=[.!?…]["'”’)\]]*)\s+/)) {
      const s = piece.trim();
      if (!s) continue;
      // "Mr. Smith", "11 p.m. the lookout…": not a new sentence.
      if (out.length && (ABBREV.test(out[out.length - 1]) || /^[a-z]/.test(s))) out[out.length - 1] += ` ${s}`;
      else out.push(s);
    }
    return out;
  }

  // A scene far longer than the target is cut at a comma / "and" / "but"… near its middle.
  function splitLong(text, target) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= target * 1.8) return [text];
    const mid = words.length / 2;
    let best = -1;
    words.forEach((w, i) => {
      if (i < 3 || i > words.length - 3) return;
      const cut = /[,;:]$/.test(w) ? i + 1 : /^(and|but|so|because|while|when|which|then)$/i.test(w) ? i : -1;
      if (cut > 0 && (best < 0 || Math.abs(cut - mid) < Math.abs(best - mid))) best = cut;
    });
    if (best < 0) best = Math.round(mid);
    return [...splitLong(words.slice(0, best).join(' '), target), ...splitLong(words.slice(best).join(' '), target)];
  }

  // Script text → [{ narration, prompt: '', chapter }]. "## Title" lines become chapters.
  // Blank lines (paragraphs) always end a scene; mode 'lines' = every line is one scene.
  function splitScript(text, mode) {
    const rows = [];
    let chapter = '';
    const blocks = [];
    let para = [];
    const endPara = () => {
      if (para.length) blocks.push({ text: para.join(' '), chapter });
      para = [];
    };
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      const m = line.match(/^##\s*(.+)$/);
      if (m) {
        endPara();
        chapter = m[1].trim();
        continue;
      }
      if (!line || mode === 'lines') {
        if (line) para.push(line);
        endPara();
        continue;
      }
      para.push(line);
    }
    endPara();

    const target = SCENE_WORDS[mode] || SCENE_WORDS.medium;
    let pendingChapter = '';
    for (const block of blocks) {
      if (block.chapter && block.chapter !== pendingChapter) pendingChapter = block.chapter;
      let scenes;
      if (mode === 'lines') {
        scenes = [block.text];
      } else {
        scenes = [];
        let cur = [];
        let words = 0;
        for (const s of sentencesOf(block.text)) {
          const n = wordCount(s);
          if (cur.length && words + n > target * 1.3 && words >= target * 0.5) {
            scenes.push(cur.join(' '));
            cur = [];
            words = 0;
          }
          cur.push(s);
          words += n;
        }
        if (cur.length) scenes.push(cur.join(' '));
        scenes = scenes.flatMap((sc) => splitLong(sc, target));
      }
      for (const narration of scenes) {
        const used = rows.some((r) => r.chapter === pendingChapter);
        rows.push({ narration: narration.replace(/\|/g, '/'), prompt: '', chapter: pendingChapter && !used ? pendingChapter : '' });
      }
    }
    return rows;
  }

  // Scene Builder rows → the scene-file text (narration | picture, ## chapters).
  function rowsToSceneFile(rows) {
    const lines = ['# Scene file made with Flow Batch Scene Builder - narration | image prompt'];
    for (const r of rows) {
      if (r.chapter && r.chapter.trim()) lines.push(`## ${r.chapter.trim()}`);
      lines.push(`${r.narration.trim().replace(/\|/g, '/')} | ${(r.prompt.trim() || r.narration.trim()).replace(/\|/g, '/')}`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  // Scene file lines are "narration | image prompt"; plain lines are just a prompt.
  function splitScene(line) {
    const bar = line.indexOf('|');
    if (bar < 0) return { text: line, narration: '' };
    return { narration: line.slice(0, bar).trim(), text: line.slice(bar + 1).trim() };
  }

  // What is actually typed into Flow: the style line + the scene's prompt.
  // Make Video effect tags ("[rain]", "[rock]" …) stay in scenes.txt but are never sent to Flow.
  const EFFECT_TAGS = /\[(zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down|rock|shake|still|rain|snow)\]/gi;
  const withoutTags = (text) => text.replace(EFFECT_TAGS, ' ').replace(/\s+/g, ' ').trim();

  function fullPrompt(p) {
    const style = (state.settings.style || '').trim().replace(/[\s,.;:]+$/, '');
    const text = withoutTags(p.text);
    return style ? `${style}, ${text}` : text;
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
    // Flow labels each attached reference as an "Ingredient".
    const ingredients = [...card.querySelectorAll('[aria-label="Ingredient"]')].filter(isVisible);
    const imgs = [...card.querySelectorAll('img')].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 28 && r.height >= 28 && isVisible(img);
    });
    return ingredients.length >= imgs.length ? ingredients : imgs;
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

  // Phone-size layout: a full-screen role=dialog "Add assets to the project".
  // Desktop layout: a popover (flow-add-menu-popover-content) with a list, a
  // preview pane and an "Add to prompt" button.
  function findAssetDialog() {
    const cands = document.querySelectorAll(
      'flow-add-menu-popover-content, .add-menu-popover-container, [role="dialog"], .cdk-overlay-pane'
    );
    for (const d of cands) {
      if (!isVisible(d) || host.contains(d)) continue;
      if (/asset/i.test(d.getAttribute('aria-label') || '') || d.querySelector('.asset-item, [aria-label="Asset list"]')) return d;
    }
    return null;
  }

  const findAddToPrompt = (dlg) =>
    [...dlg.querySelectorAll('button')].filter(isVisible).find((b) => /^add to prompt$/i.test(norm(b.innerText || b.getAttribute('aria-label') || ''))) || null;

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
      const step = (msg) => log(`  · ${msg}`);
      const plus = findPlusButton(liveCard(box));
      if (!plus) {
        step('"+" (Add ingredients) button not found');
        return false;
      }
      if (!findAssetDialog()) {
        const clicked = await trustedClickOn(plus);
        step(`clicked "+" ${clicked ? '' : '(click FAILED)'}`);
      }
      const dlg = await waitFor(findAssetDialog, 5000);
      if (!dlg) {
        step('asset dialog did not open');
        return false;
      }
      const options = () => {
        const d = findAssetDialog();
        return d ? [...d.querySelectorAll('[role="option"], .asset-item')].filter(isVisible) : [];
      };
      step(`asset dialog open – ${options().length} asset(s) listed`);

      let opt = findAssetOption(dlg, ref.name);
      if (opt) {
        step(`"${ref.name}" already in the project – re-using it`);
      } else {
        const before = new Set(options());
        const up = [...dlg.querySelectorAll('button, [role="button"]')].filter(isVisible).find((b) => /upload/i.test(buttonLabel(b)));
        if (!up) {
          step('"Upload media" button not found');
          await closeAssetDialog();
          return false;
        }
        const armed = await chrome.runtime.sendMessage({ type: 'armFileChooser', refs: [ref] });
        if (!armed || !armed.ok) {
          step(`could not prepare the upload: ${armed && armed.error}`);
          await closeAssetDialog();
          return false;
        }
        try {
          await trustedClickOn(up);
          const res = await chrome.runtime.sendMessage({ type: 'awaitFileChooser', ms: 6000 });
          if (!res.ok) {
            step(`upload dialog: ${res.error}`);
            await closeAssetDialog();
            return false;
          }
        } finally {
          await chrome.runtime.sendMessage({ type: 'disarmFileChooser' });
        }
        step(`uploading "${ref.name}"…`);
        // The new asset = by name, or else the entry that wasn't there before the upload.
        opt = await waitFor(() => {
          const o = findAssetOption(findAssetDialog() || dlg, ref.name) || options().find((x) => !before.has(x));
          return o && !isUploading(o) ? o : null;
        }, 120000, 500);
        if (!opt) {
          step('upload did not finish within 2 minutes');
          await closeAssetDialog();
          return false;
        }
        step('upload finished');
      }

      // Wait if it is still uploading, then pick it.
      if (isUploading(opt)) opt = (await waitFor(() => (!isUploading(opt) ? opt : null), 120000, 500)) || opt;
      await sleep(600);
      const picked = await trustedClickOn(opt);
      step(`clicked the asset ${picked ? '' : '(click FAILED)'}`);
      // Desktop layout: the click only previews it – confirm with "Add to prompt".
      const addBtn = await waitFor(() => {
        const d = findAssetDialog();
        return d ? findAddToPrompt(d) : 'closed';
      }, 2500);
      if (addBtn && addBtn !== 'closed') {
        await sleep(300);
        await trustedClickOn(addBtn);
        step('clicked "Add to prompt"');
      }
      await waitFor(() => !findAssetDialog(), 3000);
      if (findAssetDialog()) {
        step('dialog still open – closing it');
        await closeAssetDialog();
      }
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
      // On Flow use only its own asset dialog; the generic fallbacks would just
      // upload duplicates there. Other UIs: try the generic methods.
      const flowUI = !!liveCard(box).querySelector('button[aria-label="Add ingredients to the prompt box"]');
      const order = flowUI ? ['picker'] : ['input', 'menu', 'drop'];
      if (!flowUI && state.refMethod) order.sort((a, b) => (a === state.refMethod ? -1 : b === state.refMethod ? 1 : 0));
      log(`#${index + 1} attaching reference "${ref.name}"…`);
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
        if (tried) {
          const card = liveCard(box);
          const imgs = [...card.querySelectorAll('img')].map((i) => {
            const r = i.getBoundingClientRect();
            return `${Math.round(r.width)}x${Math.round(r.height)}`;
          });
          log(`  · no thumbnail seen in the prompt bar (<${card.tagName.toLowerCase()}>, images: ${imgs.join(', ') || 'none'}, ingredients: ${card.querySelectorAll('[aria-label="Ingredient"]').length})`);
        }
      }
      if (!ok) throw new Error(`Could not attach reference image "${ref.name}" to Flow.`);
    }
    await sleep(1500); // let Flow finish processing the upload
  }

  // One key per actual image. On wide screens Flow shows a new result twice (grid
  // tile + large preview) with different URLs for the same image – both carry the
  // same flow-content.google/image/<id>, so key on that id.
  function imageKey(src) {
    const m = src.match(/flow-content\.google\/image\/([^/?#]+)/);
    if (m) return `flow:${m[1]}`;
    if (/^(blob|data):/.test(src)) return src;
    return src.split(/[?#]/)[0];
  }

  // Map of image key → URL of its largest copy on the page.
  function collectImages(skip) {
    const found = new Map();
    for (const img of document.querySelectorAll('img')) {
      if (skip && skip.contains(img)) continue;
      if (img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256) {
        const src = img.currentSrc || img.src;
        if (!src) continue;
        const key = imageKey(src);
        const prev = found.get(key);
        if (!prev || img.naturalWidth > prev.w) found.set(key, { src, w: img.naturalWidth });
      }
    }
    return new Map([...found].map(([k, v]) => [k, v.src]));
  }

  // Flow's settings chip reads e.g. "🍌 Nano Banana 2.1 crop_16_9 x2" – use its count.
  function flowImageCount() {
    const chip = document.querySelector('button[aria-label="Settings trigger"]');
    const m = chip && (chip.innerText || '').match(/\bx(\d{1,2})\b/);
    return m ? Number(m[1]) : 0;
  }

  // Flow's own error messages. Counted before and during a prompt, so a failed
  // generation is noticed at once instead of after the full timeout.
  const FLOW_ERROR = /something went wrong|failed to generate|couldn['’]t generate|could not generate|unable to generate|generation failed|try again later|violates?|against our polic|limit reached|reached your (?:daily )?limit|quota|too many requests/gi;
  function flowErrors() {
    // The panel lives outside <body>, so its own log never counts.
    return (document.body ? document.body.innerText : '').match(FLOW_ERROR) || [];
  }

  // Every error message Flow ADDS to the page (toasts, failed tiles) – also when the
  // same message is still showing from an earlier prompt.
  const flowErrorSeen = { count: 0, last: '' };
  if (document.body) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          const t = (n.nodeType === 1 ? n.innerText || n.textContent : n.textContent) || '';
          const hit = t.length < 400 && t.match(FLOW_ERROR);
          if (hit) {
            flowErrorSeen.count++;
            flowErrorSeen.last = hit[hit.length - 1];
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function claim(keys) {
    const set = new Set(state.claimed);
    for (const k of keys) if (!set.has(k)) state.claimed.push(k);
  }

  // A result that appears in less than half the time of Flow's FASTEST recent image
  // can't be this prompt's picture: it is a late image of the prompt that gave up.
  function tooEarlyMs() {
    if (state.genTimes.length < 3) return 0;
    return Math.max(1.5, 0.5 * Math.min(...state.genTimes)) * 1000;
  }

  // Images of one prompt: a Map key → src of images that weren't there before.
  function freshImages(box, before) {
    return [...collectImages(liveCard(box))].filter(([k]) => !before.has(k));
  }

  // lateFor: { i, seen } – the last prompt that gave up and the images that were on
  // the page at that moment. Anything that appeared since is that prompt's late image.
  async function runOne(index, lateFor) {
    const p = state.prompts[index];
    let box = findPromptBox();
    if (!box) throw new Error('Prompt box not found – set a prompt selector under Advanced.');

    await ensureReferences(box, index);
    box = findPromptBox() || box;

    // Snapshot existing images (incl. the references and every image already given
    // to a scene) so only new results count.
    const refKeys = [...liveCard(box).querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter(Boolean).map(imageKey);
    const late = [];
    const pageNow = collectImages();
    if (lateFor) {
      const claimed = new Set(state.claimed);
      for (const [k, src] of pageNow) if (!lateFor.seen.has(k) && !claimed.has(k)) late.push(src);
    }
    const pageKeys = [...pageNow.keys()];
    claim(pageKeys);
    // Retrying the prompt that gave up, and its image has arrived meanwhile: use it
    // instead of generating (and paying for) a new one.
    if (lateFor && lateFor.i === index && late.length) {
      log(`#${index + 1}: its image arrived late – using it, no new generation`);
      return { status: 'done', fresh: late, late: [] };
    }
    const before = new Set([...pageKeys, ...refKeys, ...state.claimed]);
    const errorsBefore = flowErrors().length;
    const errorEventsBefore = flowErrorSeen.count;
    const prompt = fullPrompt(p);
    setText(box, prompt);
    await sleep(800);

    if (!(await submitPrompt(box, prompt, index))) {
      throw new Error('Flow did not accept the prompt – use Advanced → Test detection, or set the button selector.');
    }

    const { stableSec, timeoutSec, graceSec } = state.settings;
    const perPrompt = flowImageCount() || state.settings.perPrompt;
    const early = lateFor ? tooEarlyMs() : 0;
    const start = Date.now();
    let firstAt = 0;
    let lastCount = 0;
    let lastChange = Date.now();
    while (!state.stopRequested) {
      await sleep(1000);
      const elapsed = Date.now() - start;
      for (const [k, src] of freshImages(box, before)) {
        if (early && elapsed < early) {
          // Too early for this prompt: it belongs to the earlier prompt that gave up.
          late.push(src);
          before.add(k);
          claim([k]);
        }
      }
      const fresh = freshImages(box, before).map(([, src]) => src);
      if (fresh.length && !firstAt) firstAt = elapsed;
      if (fresh.length !== lastCount) {
        lastCount = fresh.length;
        lastChange = Date.now();
        setRowNote(index, `${fresh.length} image(s)…`);
      }
      const finish = (status) => {
        claim(freshImages(box, before).map(([k]) => k));
        if (status === 'done' && firstAt) state.genTimes = [...state.genTimes, firstAt / 1000].slice(-15);
        return { status, fresh, late };
      };
      const quiet = Date.now() - lastChange;
      if (fresh.length >= perPrompt && quiet >= 2000) return finish('done');
      if (fresh.length > 0 && quiet >= stableSec * 1000) return finish('done');
      if (!fresh.length) {
        const errs = flowErrors();
        const newEvent = flowErrorSeen.count > errorEventsBefore;
        if ((errs.length > errorsBefore || newEvent) && elapsed > 3000) {
          const what = newEvent ? flowErrorSeen.last : errs[errs.length - 1];
          return { status: 'error', fresh, late, seen: new Set(collectImages().keys()), reason: `Flow showed an error ("${what}")` };
        }
      }
      if (elapsed > timeoutSec * 1000) {
        if (fresh.length) return finish('done');
        // Gave up – but keep watching a little longer, so a slow image still lands
        // here and not in the next scene.
        setRowNote(index, 'waiting for a late image…');
        const until = Date.now() + graceSec * 1000;
        while (Date.now() < until && !state.stopRequested) {
          await sleep(1000);
          if (freshImages(box, before).length) {
            await sleep(2000);
            const got = freshImages(box, before).map(([, src]) => src);
            claim(freshImages(box, before).map(([k]) => k));
            return { status: 'done', fresh: got, late };
          }
        }
        return { status: 'timeout', fresh: [], late, seen: new Set(collectImages().keys()), reason: `no image after ${timeoutSec + graceSec} s` };
      }
    }
    return { status: 'pending', fresh: [], late };
  }

  // ---------- downloads ----------

  function slug(text) {
    return (
      withoutTags(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'prompt'
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

  // getBlob with retries; a failed URL is looked up again on the page by its image key.
  async function getBlobSafe(src) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const blob = await getBlob(src);
        if (blob && blob.size > 1000) return blob;
        throw new Error('empty image');
      } catch (e) {
        lastErr = e;
        const again = collectImages().get(imageKey(src));
        if (again) src = again;
        await sleep(1500 * attempt);
      }
    }
    throw lastErr;
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

  // Write one file into this run's folder (chosen save folder, or Chrome Downloads).
  async function writeToRun(name, blob, replace = false) {
    const runDir = state.runFolder || 'FlowBatch';
    const dir = await folderReady(false);
    if (dir) {
      try {
        const target = await dir.getDirectoryHandle(runDir, { create: true });
        const fh = await target.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        return;
      } catch (e) {
        log(`Folder error: ${e.message} – using Chrome Downloads instead`);
      }
    }
    const folder = state.settings.folder.replace(/[\\:*?"<>|]/g, '_');
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      url: await blobToDataUrl(blob),
      filename: `${folder}/${runDir}/${name}`,
      replace
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'download failed');
  }

  // Save scenes.txt next to the images: Make Video reads the narration from it.
  // Above every scene a "# image:" note names the image file(s) saved for it; the
  // file is rewritten after each prompt, so it always matches the folder.
  async function saveSceneFile(quiet) {
    if (!state.prompts.some((p) => p.narration)) return;
    const lines = [
      '# Scene file written by Flow Batch - one line per image: narration | image prompt',
      '# The "# image:" line above each scene names the image saved for it.',
      ''
    ];
    state.prompts.forEach((p, i) => {
      if (p.chapter) lines.push(`## ${p.chapter}`);
      const files = p.files && p.files.length ? p.files.join(', ')
        : p.status === 'done' || p.status === 'nosave' ? '(not saved - use Retry failed)'
        : p.status === 'error' || p.status === 'timeout' ? '(failed - use Retry failed)' : '(not made yet)';
      lines.push(`# image: ${files}`);
      lines.push(`${p.narration || ''} | ${p.text}`);
    });
    try {
      await writeToRun('scenes.txt', new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/plain' }), true);
      if (!quiet) log('Saved scenes.txt (narration + image names, for Make Video) in the run folder');
    } catch (e) {
      log(`Could not save scenes.txt: ${e.message}`);
    }
  }

  async function saveImages(index, srcs) {
    const p = state.prompts[index];
    const base = `${String(index + 1).padStart(3, '0')}_${slug(p.text)}`;
    // Remember where the images are, so a failed download can be repeated later
    // without generating again (page-only blob:/data: URLs can't be kept).
    p.found = srcs.filter((src) => !/^(blob|data):/.test(src));
    let saved = 0;
    let failed = 0;
    const names = [];
    const hashes = new Set();
    for (let k = 0; k < srcs.length; k++) {
      try {
        const blob = await getBlobSafe(srcs[k]);
        // Skip byte-identical copies (same image reached through two URLs).
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (hashes.has(hash)) continue;
        hashes.add(hash);
        const name = `${base}_${saved + 1}.${extFor(srcs[k], blob.type)}`;
        await writeToRun(name, blob);
        names.push(name);
        saved++;
      } catch (e) {
        failed++;
        log(`#${index + 1} save failed: ${e.message}`);
      }
    }
    p.files = names;
    p.status = failed && !saved ? 'nosave' : 'done';
    return saved;
  }

  async function fixDownloads() {
    const todo = state.prompts.map((p, i) => [p, i]).filter(([p]) => p.status === 'nosave');
    if (!todo.length) return;
    log(`Downloading ${todo.length} image(s) again that were not saved…`);
    for (const [p, i] of todo) {
      if (state.stopRequested) break;
      if (!p.found || !p.found.length) {
        p.status = 'error';
        log(`#${i + 1}: the image is no longer reachable – it will be generated again`);
        continue;
      }
      const n = await saveImages(i, p.found);
      log(n ? `#${i + 1} saved now` : `#${i + 1} still not saved – it will be generated again on the next Retry`);
      if (!n) p.status = 'error';
    }
    save();
    render();
  }

  // ---------- folder check: the folder is the truth ----------

  async function listRunFiles() {
    const dir = await folderReady(false);
    if (dir) {
      try {
        const sub = await dir.getDirectoryHandle(state.runFolder);
        const names = [];
        for await (const [name, h] of sub.entries()) if (h.kind === 'file') names.push(name);
        return names;
      } catch {
        return [];
      }
    }
    const res = await chrome.runtime.sendMessage({ type: 'listDownloads', folder: `${state.settings.folder}/${state.runFolder}` });
    return (res && res.ok && res.names) || null;
  }

  async function checkFolder(quiet) {
    if (!state.runFolder) {
      if (!quiet) log('Nothing to check yet – no run folder (press Start first).');
      return;
    }
    const names = await listRunFiles();
    if (!names) {
      if (!quiet) log('Could not read the save folder.');
      return;
    }
    let ok = 0;
    let found = 0;
    let missing = 0;
    state.prompts.forEach((p, i) => {
      const prefix = `${String(i + 1).padStart(3, '0')}_`;
      const files = names.filter((n) => n.startsWith(prefix) && /\.(png|jpe?g|webp|gif)$/i.test(n)).sort();
      if (files.length) {
        if (p.status !== 'done') found++;
        else ok++;
        p.files = files;
        p.images = Math.max(p.images || 0, files.length);
        p.status = 'done';
      } else if (p.status === 'done' || p.status === 'nosave') {
        p.files = [];
        p.status = p.found && p.found.length ? 'nosave' : 'error';
        missing++;
      }
    });
    save();
    render();
    if (state.settings.autoDownload) await saveSceneFile(true);
    if (!quiet || missing || found) {
      log(`Folder check: ${ok + found} scene(s) have their image` + (found ? ` (${found} found in the folder)` : '') +
        (missing ? `, ${missing} missing – Retry failed downloads or makes them again` : ', nothing missing') + '. scenes.txt updated.');
    }
  }

  // Backup of the prompt list in the run folder, in the "(narration)" + prompt format.
  // Make Video uses it when scenes.txt is missing.
  async function saveBackupList() {
    const lines = ['# Backup of the prompt list of this run (Flow Batch). Make Video uses it if scenes.txt is missing.', ''];
    for (const p of state.prompts) {
      if (p.chapter) lines.push(`## ${p.chapter}`);
      if (p.narration) lines.push(`(${p.narration})`);
      lines.push(p.text || '-', '');
    }
    try {
      await writeToRun('prompts-backup.txt', new Blob([lines.join('\r\n')], { type: 'text/plain' }), true);
    } catch (e) {
      log(`Could not save prompts-backup.txt: ${e.message}`);
    }
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
    if (!state.runFolder || !state.prompts.some((p) => p.status === 'done' || p.status === 'nosave')) {
      state.runFolder = newRunFolder();
      save();
    }
    render();
    log(`Started – saving to ${dirHandle ? dirHandle.name : 'Chrome Downloads/' + state.settings.folder}/${state.runFolder}`);
    if (state.refs.length) log(`Using ${state.refs.length} reference image(s) for every prompt`);
    if ((state.settings.style || '').trim()) log(`Style added to every prompt: "${state.settings.style.trim()}"`);
    if (state.settings.autoDownload) {
      if (state.prompts.some((p) => p.status === 'done' || p.status === 'nosave')) await checkFolder(true);
      await saveSceneFile();
      await saveBackupList();
      await fixDownloads();
    }

    let failStreak = 0;
    const streak = []; // prompts that failed in a row
    let lastFailed = null; // { i, seen } – the last prompt that gave up; its image may still arrive late
    const runPass = async () => {
      for (let i = 0; i < state.prompts.length && !state.stopRequested; i++) {
        const p = state.prompts[i];
        if (p.status !== 'pending' && p.status !== 'error' && p.status !== 'timeout') continue;
        if (p.status !== 'pending' && !runPass.includeFailed) continue;
        for (let attempt = 0; ; attempt++) {
          while (state.paused && !state.stopRequested) await sleep(300);
          if (state.stopRequested) break;
          p.status = 'running';
          render();
          let res;
          try {
            res = await runOne(i, lastFailed);
          } catch (e) {
            res = { status: 'error', fresh: [], late: [], reason: e.message };
          }
          if (res.late && res.late.length && lastFailed) {
            // An earlier prompt's image arrived late – it goes to that scene, not this one.
            const li = lastFailed.i;
            const q = state.prompts[li];
            if (q.status !== 'done' && li !== i) {
              log(`#${li + 1}: its image arrived late – saved for scene ${li + 1}`);
              q.images = res.late.length;
              if (state.settings.autoDownload) await saveImages(li, res.late);
              else q.status = 'done';
            }
            lastFailed = null;
          }
          if (res.status === 'pending') {
            p.status = 'pending';
            break;
          }
          if (res.status === 'done') {
            p.images = res.fresh.length;
            if (state.settings.autoDownload) {
              const n = await saveImages(i, res.fresh);
              log(`#${i + 1} done – ${res.fresh.length} image(s), ${n} saved` + (p.status === 'nosave' ? ' – will try the download again' : ''));
            } else {
              p.status = 'done';
              log(`#${i + 1} done – ${res.fresh.length} image(s)`);
            }
            failStreak = 0;
            streak.length = 0;
            state.recoverRound = 0;
            if (lastFailed && lastFailed.i === i) lastFailed = null;
            break;
          }
          p.status = res.status;
          lastFailed = res.seen ? { i, seen: res.seen } : null;
          log(`#${i + 1} ${res.status === 'timeout' ? 'timed out' : 'failed'}: ${res.reason || ''}`);
          // Without the references every result would be wrong – stop instead of wasting credits.
          if (/reference image/i.test(res.reason || '')) {
            state.stopRequested = true;
            log('Stopped so no credits are wasted. Check the reference images and press Resume.');
            break;
          }
          // Flow refuses this wording – trying again would only cost credits.
          if (/violat|polic/i.test(res.reason || '')) {
            log(`#${i + 1}: Flow refused this prompt – change its wording, then Retry failed`);
            break;
          }
          failStreak++;
          streak.push(i);
          if (failStreak >= 3) {
            // These failed because Flow was down, not because of their prompts: queue
            // them again before pausing / reloading.
            for (const k of streak) if (state.prompts[k].status !== 'done') state.prompts[k].status = 'pending';
            save();
            await recover(failStreak);
            if (state.stopRequested) break;
            failStreak = 0;
            streak.length = 0;
            continue;
          }
          if (attempt >= (runPass.includeFailed ? 0 : state.settings.retries)) break;
          log(`#${i + 1}: trying again (${attempt + 1}/${state.settings.retries})…`);
          await interruptibleSleep(5000);
        }
        save();
        render();
        if (state.settings.autoDownload) await saveSceneFile(true);
        if (i < state.prompts.length - 1) await interruptibleSleep(state.settings.delaySec * 1000);
      }
    };
    runPass.includeFailed = false;
    await runPass();
    // One more round for what failed, now that Flow had time to recover.
    const failedNow = state.prompts.filter((p) => p.status === 'error' || p.status === 'timeout').length;
    if (failedNow && !state.stopRequested && state.settings.retries > 0) {
      log(`Second round for ${failedNow} failed prompt(s)…`);
      runPass.includeFailed = true;
      await runPass();
    }
    if (state.settings.autoDownload && !state.stopRequested) {
      await fixDownloads();
      await checkFolder(true);
    }

    state.running = false;
    state.paused = false;
    chrome.runtime.sendMessage({ type: 'detach' }).catch(() => {}); // removes the "debugging" bar
    const left = state.prompts.filter((p) => p.status !== 'done').length;
    log(state.stopRequested ? 'Stopped' : left ? `Finished – ${left} scene(s) still without an image: press Retry failed` : 'Finished all prompts – every scene has its image');
    state.stopRequested = false;
    render();
  }

  // Flow failed several times in a row: wait (2, then 5, then 10 minutes), reload
  // the page and carry on by itself. After three rounds, stop.
  async function recover(fails) {
    const waits = [2, 5, 10];
    const round = state.recoverRound;
    if (!state.settings.autoRecover || round >= waits.length) {
      state.stopRequested = true;
      log(`Flow failed ${fails} times in a row – stopped. Check Flow (limits, errors), then press Start to continue.`);
      return;
    }
    log(`Flow failed ${fails} times in a row – pausing ${waits[round]} min, then reloading the page and continuing by itself…`);
    const scale = (window.__flowBatchTest && window.__flowBatchTest.recoverScale) || 1; // tests only
    await interruptibleSleep(waits[round] * 60000 * scale);
    if (state.stopRequested) return;
    state.recoverRound = round + 1;
    state.prompts.forEach((p) => {
      if (p.status === 'running') p.status = 'pending';
    });
    state.resumeAfterReload = true;
    save();
    await sleep(500);
    location.reload();
    await sleep(60000); // the reload ends this script
  }

  // ---------- panel UI (shadow DOM so Flow's styles don't clash) ----------

  const host = document.createElement('div');
  host.id = 'flow-batch-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { position: fixed; right: 16px; bottom: 16px; width: clamp(300px, 26vw, 420px);
        max-height: calc(100vh - 32px); display: flex; flex-direction: column; z-index: 2147483647;
        font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #e8eaed;
        background: #202124; border: 1px solid #3c4043; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden; }
      .panel.moved { right: auto; bottom: auto; }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #292a2d;
        cursor: move; user-select: none; touch-action: none; }
      .head b { flex: 1; font-size: 14px; }
      .head button { cursor: pointer; }
      /* Two zones: the setup scrolls when the screen is short; the run zone (buttons,
         progress, list, log) always stays fully visible. */
      .body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
      .setup { padding: 10px 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px;
        flex: 0 1 auto; min-height: 64px; }
      .run { padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 8px; flex: 0 0 auto;
        border-top: 1px solid #3c4043; background: #1d1e20; }
      .setup > *, .run > * { flex-shrink: 0; }
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
      .list { border: 1px solid #3c4043; border-radius: 8px; max-height: clamp(64px, 24vh, 260px); overflow: auto; }
      .list:empty { display: none; }
      .item { display: grid; grid-template-columns: 22px 30px 1fr; gap: 4px; padding: 4px 6px;
        border-bottom: 1px solid #303134; }
      .item:last-child { border-bottom: 0; }
      .item .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .item.running { background: #283142; }
      .item .note { grid-column: 3; color: #9aa0a6; font-size: 11px; }
      .bar { height: 6px; background: #3c4043; border-radius: 3px; overflow: hidden; }
      .bar > div { height: 100%; background: #8ab4f8; width: 0; transition: width .3s; }
      .log { font: 11px/1.4 ui-monospace, Consolas, monospace; background: #171717; border-radius: 6px;
        padding: 6px; height: clamp(64px, 16vh, 200px); box-sizing: border-box; overflow: auto;
        white-space: pre-wrap; overflow-wrap: anywhere; color: #bdc1c6; }
      @media (max-height: 620px) {
        .list { max-height: 72px; }
        .log { height: 60px; }
      }
      @media (max-width: 640px) {
        .panel:not(.moved) { left: 8px; right: 8px; bottom: 8px; width: auto; }
      }
      details summary { cursor: pointer; color: #9aa0a6; }
      label.chk { display: flex; gap: 6px; align-items: center; }
      .refs { display: flex; gap: 8px; }
      .refs:empty { display: none; }
      .ref { position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden;
        border: 1px solid #5f6368; }
      .ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .ref button { position: absolute; top: 2px; right: 2px; padding: 0 5px; font-size: 12px;
        line-height: 16px; border-radius: 8px; background: rgba(0,0,0,.7); }

      /* ---- Scene Builder ---- */
      .sb-back { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #e8eaed; }
      .sb-back[hidden] { display: none; }
      .sb { width: min(1100px, calc(100vw - 32px)); height: calc(100vh - 48px); background: #202124;
        border: 1px solid #3c4043; border-radius: 12px; display: flex; flex-direction: column;
        box-shadow: 0 12px 40px rgba(0,0,0,.6); overflow: hidden; }
      .sb-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #292a2d; }
      .sb-head b { font-size: 15px; flex: 1; }
      .sb-top { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 12px 16px;
        border-bottom: 1px solid #3c4043; }
      .sb-top textarea { width: 100%; height: 110px; resize: vertical; box-sizing: border-box; font: inherit;
        color: #e8eaed; background: #303134; border: 1px solid #5f6368; border-radius: 8px; padding: 8px; }
      .sb-side { display: flex; flex-direction: column; gap: 6px; min-width: 230px; }
      .sb-side select, .sb-side input { width: 100%; }
      .sb-help { color: #9aa0a6; font-size: 12px; padding: 6px 16px; }
      .sb-rows { flex: 1; overflow: auto; padding: 0 16px 8px; }
      .sb-row { display: grid; grid-template-columns: 34px 1fr 1fr 64px; gap: 8px; align-items: start;
        padding: 8px 0; border-bottom: 1px solid #303134; }
      .sb-row.head { position: sticky; top: 0; background: #202124; z-index: 1; color: #9aa0a6;
        font-size: 12px; padding: 8px 0 6px; }
      .sb-num { color: #9aa0a6; padding-top: 6px; text-align: right; }
      .sb-row textarea { width: 100%; box-sizing: border-box; min-height: 52px; resize: vertical; font: inherit;
        color: #e8eaed; background: #303134; border: 1px solid #5f6368; border-radius: 6px; padding: 6px; }
      .sb-row textarea::placeholder { color: #8f949a; font-style: italic; }
      .sb-row input.sb-ch { width: 100%; box-sizing: border-box; margin-bottom: 4px; font-size: 12px; }
      .sb-acts { display: flex; flex-direction: column; gap: 4px; }
      .sb-acts button { padding: 3px 6px; font-size: 12px; }
      .sb-foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: #292a2d;
        border-top: 1px solid #3c4043; }
      .sb-foot .muted { flex: 1; }
      .sb-empty { color: #9aa0a6; text-align: center; padding: 40px 0; }
      @media (max-width: 760px) {
        .sb { width: calc(100vw - 16px); height: calc(100vh - 16px); }
        .sb-top { grid-template-columns: 1fr; }
        .sb-side { min-width: 0; }
        .sb-row { grid-template-columns: 26px 1fr; }
        .sb-row.head { display: none; }
        .sb-row > textarea, .sb-acts { grid-column: 2; }
        .sb-acts { flex-direction: row; flex-wrap: wrap; }
        .sb-foot { flex-wrap: wrap; }
      }
      @media (max-height: 600px) {
        .sb { height: calc(100vh - 16px); }
        .sb-top textarea { height: 64px; }
      }
    </style>
    <div class="panel">
      <div class="head">
        <b title="Drag to move · double-click to put it back in the corner">Flow Batch <span class="muted" id="ver"></span></b>
        <button class="icon" id="min" title="Minimise">–</button>
        <button class="icon" id="close" title="Hide (click the toolbar icon to show again)">×</button>
      </div>
      <div class="body">
       <div class="setup">
        <div class="row">
          <button id="build" class="primary" title="Paste a plain script – it is split into scenes for you">Scene Builder…</button>
          <button id="pick">Load .txt file…</button>
          <select id="splitMode" style="width:auto">
            <option value="line">One prompt per line</option>
            <option value="blank">Separated by blank line</option>
          </select>
          <input type="file" id="file" accept=".txt,text/plain" hidden>
        </div>
        <div class="muted" id="fileInfo">No file loaded.</div>
        <input type="text" data-k="style" placeholder="Style for every prompt, e.g. 2D stickman cartoon, flat colours, white background"
          title="Added in front of every prompt, so all images share one look">

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
        <details>
          <summary>Settings</summary>
          <div class="grid" style="margin-top:6px">
            <span>Images per prompt</span><input type="number" min="1" max="8" data-k="perPrompt">
            <span>Wait between prompts (s)</span><input type="number" min="0" data-k="delaySec">
            <span>Done when no new image for (s)</span><input type="number" min="2" data-k="stableSec">
            <span>Give up after (s)</span><input type="number" min="30" data-k="timeoutSec">
            <span>Wait for a late image (s)</span><input type="number" min="0" data-k="graceSec">
            <span>Try a failed prompt again (times)</span><input type="number" min="0" max="5" data-k="retries">
          </div>
          <label class="chk" style="margin-top:6px"><input type="checkbox" data-k="autoRecover"> If Flow keeps failing: pause, reload the page and continue</label>
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
       </div>
       <div class="run">
        <div class="row">
          <button class="primary" id="start">Start</button>
          <button id="pause">Pause</button>
          <button id="stop">Stop</button>
          <button id="retry" title="Run again only the prompts that failed (❌) or timed out (⚠️)">Retry failed</button>
          <button id="reset" title="Mark every prompt as not done">Reset</button>
          <button id="check" title="Compare the save folder with the list: missing images are queued for Retry, scenes.txt is rewritten">Check folder</button>
        </div>
        <div class="bar"><div id="bar"></div></div>
        <div class="list" id="list"></div>
        <div class="log" id="log"></div>
       </div>
      </div>
    </div>
    <div class="sb-back" id="sb" hidden>
      <div class="sb">
        <div class="sb-head">
          <b>Scene Builder</b>
          <button class="icon" id="sbClose" title="Close (your work is kept)">×</button>
        </div>
        <div class="sb-top">
          <textarea id="sbScript" placeholder="Paste your narration script here – just the words you will say, as normal text.

Optional: a line like  ## The storm  starts a YouTube chapter."></textarea>
          <div class="sb-side">
            <span class="muted">Scene length</span>
            <select id="sbMode">
              <option value="short">Short – about 1 sentence (~5 s)</option>
              <option value="medium">Medium – about 2 sentences (~9 s)</option>
              <option value="long">Long – about 3 sentences (~14 s)</option>
              <option value="lines">Each line I wrote = one scene</option>
            </select>
            <button class="primary" id="sbSplit">Split into scenes ↓</button>
            <span class="muted">Video name</span>
            <input type="text" id="sbName" placeholder="my-video">
          </div>
        </div>
        <div class="sb-help">Each scene shows one picture while its narration is spoken. The <b>picture</b> box is
          optional: left empty, the narration itself (plus your Style) is sent to Flow – type only where you want a
          specific picture. Edit, merge or delete scenes freely.</div>
        <div class="sb-rows" id="sbRows"></div>
        <div class="sb-foot">
          <span class="muted" id="sbInfo"></span>
          <button id="sbAdd">+ Add scene</button>
          <button id="sbSave" title="Save the scene file (.txt) to keep or edit later">Save .txt</button>
          <button class="primary" id="sbUse">Use these scenes</button>
        </div>
      </div>
    </div>`;

  const $ = (id) => root.getElementById(id);
  const ICON = { pending: '○', running: '⏳', done: '✅', timeout: '⚠️', error: '❌', nosave: '💾' };

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
      row.title = (p.narration ? `Narration: ${p.narration}\n` : '') + `Prompt: ${fullPrompt(p)}`;
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
      if (p.status === 'nosave') note.textContent = 'image made but not saved – Retry failed downloads it';
      row.append(icon, num, text, note);
      list.append(row);
    });
    const running = list.querySelector('.running');
    if (running) running.scrollIntoView({ block: 'nearest' });

    const done = state.prompts.filter((p) => p.status === 'done').length;
    const failed = state.prompts.filter((p) => ['error', 'timeout', 'nosave'].includes(p.status)).length;
    const pending = state.prompts.filter((p) => p.status === 'pending').length;
    const total = state.prompts.length;
    $('bar').style.width = total ? `${(done / total) * 100}%` : '0';
    $('fileInfo').textContent = total
      ? `${state.fileName || 'Prompts'} – ${total} prompts, ${done} done` + (failed ? `, ${failed} failed` : '')
      : 'No file loaded.';

    $('start').disabled = state.running || !pending;
    $('start').textContent = done + failed > 0 && pending ? 'Resume' : 'Start';
    $('retry').disabled = state.running || !failed;
    $('retry').textContent = failed ? `Retry failed (${failed})` : 'Retry failed';
    $('pause').disabled = !state.running;
    $('pause').textContent = state.paused ? 'Continue' : 'Pause';
    $('stop').disabled = !state.running;
    $('reset').disabled = state.running || !total;
    $('check').disabled = state.running || !state.runFolder;
    $('pick').disabled = state.running;
    $('build').disabled = state.running;
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
    state.prompts = parseScenes(rawFileText, state.settings.splitMode).map((scene) => ({
      ...scene,
      status: 'pending',
      images: 0
    }));
    state.runFolder = ''; // new file → new run folder
    state.claimed = [];
    state.recoverRound = 0;
    save();
    render();
    const scenes = state.prompts.filter((p) => p.narration).length;
    log(`Loaded ${state.prompts.length} prompts` + (scenes ? ` (scene file: ${scenes} with narration)` : ''));
    const empty = state.prompts.findIndex((p) => !p.text);
    if (empty >= 0) log(`⚠ Scene ${empty + 1} has narration but no image prompt (after "|" or on the line below the (narration))`);
    if (!scenes && state.prompts.some((p) => wordCount(p.text) > 30)) {
      log('Tip: this looks like a plain script. Use Scene Builder… to split it into scenes with narration.');
    }
  }

  // ---------- Scene Builder window ----------

  const builder = () => state.builder;
  const safeName = () => (builder().name || 'my-video').trim().replace(/[\\/:*?"<>|]/g, '_') || 'my-video';
  let saveTimer = 0;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  };

  // Cut one scene in two: at the sentence nearest the middle, else at a comma/"and"/"but".
  function splitInTwo(text) {
    const sentences = sentencesOf(text);
    const total = wordCount(text);
    if (sentences.length > 1) {
      let best = 1;
      let acc = 0;
      sentences.forEach((s, i) => {
        acc += wordCount(s);
        if (i < sentences.length - 1 && Math.abs(acc - total / 2) < Math.abs(wordCount(sentences.slice(0, best).join(' ')) - total / 2)) best = i + 1;
      });
      return [sentences.slice(0, best).join(' '), sentences.slice(best).join(' ')];
    }
    // One sentence: cut at a comma or before "and/but/…" nearest the middle.
    const words = text.split(/\s+/).filter(Boolean);
    const mid = words.length / 2;
    let best = -1;
    words.forEach((w, i) => {
      if (i < 2 || i > words.length - 2) return;
      const cut = /[,;:]$/.test(w) ? i + 1 : /^(and|but|so|because|while|when|which|then)$/i.test(w) ? i : -1;
      if (cut > 0 && (best < 0 || Math.abs(cut - mid) < Math.abs(best - mid))) best = cut;
    });
    if (best < 0) {
      if (words.length < 16) return [text, '']; // no natural place – don't chop a short sentence
      best = Math.round(mid);
    }
    return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  }

  function builderInfo(note) {
    const rows = builder().rows;
    const words = rows.reduce((n, r) => n + wordCount(r.narration), 0);
    const secs = Math.round(words / 2.5);
    const custom = rows.filter((r) => r.prompt.trim()).length;
    const chapters = rows.filter((r) => r.chapter.trim()).length;
    $('sbInfo').textContent =
      note ||
      (rows.length
        ? `${rows.length} scenes · about ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} of narration · ` +
          `${custom} with their own picture` + (chapters ? ` · ${chapters} chapter(s)` : '')
        : 'No scenes yet – paste your script above and click "Split into scenes".');
    $('sbUse').disabled = !rows.length || state.running;
    $('sbSave').disabled = !rows.length;
  }

  function renderBuilder() {
    const box = $('sbRows');
    box.textContent = '';
    const rows = builder().rows;
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = 'Your scenes will appear here.';
      box.append(empty);
      return builderInfo();
    }
    const head = document.createElement('div');
    head.className = 'sb-row head';
    for (const t of ['#', 'Narration – what is said', 'Picture – optional (empty = the narration is used)', '']) {
      const s = document.createElement('span');
      s.textContent = t;
      head.append(s);
    }
    box.append(head);
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'sb-row';
      row.dataset.i = i;
      const num = document.createElement('span');
      num.className = 'sb-num';
      num.textContent = i + 1;
      const left = document.createElement('div');
      const ch = document.createElement('input');
      ch.type = 'text';
      ch.className = 'sb-ch';
      ch.placeholder = 'Chapter title (optional)';
      ch.value = r.chapter;
      ch.dataset.f = 'chapter';
      const narr = document.createElement('textarea');
      narr.value = r.narration;
      narr.dataset.f = 'narration';
      left.append(ch, narr);
      const pic = document.createElement('textarea');
      pic.value = r.prompt;
      pic.placeholder = r.narration;
      pic.dataset.f = 'prompt';
      pic.title = 'Describe the picture for this scene. Leave empty to use the narration.';
      const acts = document.createElement('div');
      acts.className = 'sb-acts';
      for (const [label, action, title] of [
        ['↑ Merge', 'merge', 'Join this scene onto the one above'],
        ['✂ Split', 'split', 'Cut this scene in two'],
        ['Delete', 'del', 'Remove this scene']
      ]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.a = action;
        b.title = title;
        if (action === 'merge' && i === 0) b.disabled = true;
        acts.append(b);
      }
      row.append(num, left, pic, acts);
      box.append(row);
    });
    builderInfo();
  }

  function openBuilder() {
    $('sbScript').value = builder().script;
    $('sbMode').value = builder().mode;
    $('sbName').value = builder().name;
    renderBuilder();
    $('sb').hidden = false;
    if (!builder().rows.length) $('sbScript').focus();
  }

  function closeBuilder() {
    $('sb').hidden = true;
    save();
  }

  $('build').onclick = openBuilder;
  $('sbClose').onclick = closeBuilder;
  $('sb').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBuilder();
  });
  $('sbScript').oninput = () => {
    builder().script = $('sbScript').value;
    saveSoon();
  };
  $('sbMode').onchange = () => {
    builder().mode = $('sbMode').value;
    saveSoon();
  };
  $('sbName').oninput = () => {
    builder().name = $('sbName').value;
    saveSoon();
  };

  let replaceArmed = 0;
  $('sbSplit').onclick = () => {
    const text = $('sbScript').value.trim();
    if (!text) return builderInfo('Paste your script in the box first.');
    // Replacing scenes you may have edited needs a second click.
    if (builder().rows.length && Date.now() - replaceArmed > 4000) {
      replaceArmed = Date.now();
      $('sbSplit').textContent = 'Click again to replace the scenes';
      setTimeout(() => ($('sbSplit').textContent = 'Split into scenes ↓'), 4000);
      return;
    }
    replaceArmed = 0;
    $('sbSplit').textContent = 'Split into scenes ↓';
    builder().script = $('sbScript').value;
    builder().mode = $('sbMode').value;
    builder().rows = splitScript(text, builder().mode);
    save();
    renderBuilder();
  };

  $('sbRows').addEventListener('input', (e) => {
    const field = e.target.dataset && e.target.dataset.f;
    const row = e.target.closest('.sb-row');
    if (!field || !row) return;
    builder().rows[+row.dataset.i][field] = e.target.value;
    if (field === 'narration') row.querySelector('[data-f="prompt"]').placeholder = e.target.value;
    builderInfo();
    saveSoon();
  });

  $('sbRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const i = +b.closest('.sb-row').dataset.i;
    const rows = builder().rows;
    if (b.dataset.a === 'merge' && i > 0) {
      const [prev, cur] = [rows[i - 1], rows[i]];
      prev.narration = `${prev.narration} ${cur.narration}`.trim();
      if (cur.prompt.trim()) prev.prompt = prev.prompt.trim() ? `${prev.prompt.trim()}; ${cur.prompt.trim()}` : cur.prompt;
      if (!prev.chapter && cur.chapter) prev.chapter = cur.chapter;
      rows.splice(i, 1);
    } else if (b.dataset.a === 'split') {
      const [a, rest] = splitInTwo(rows[i].narration);
      if (!rest) return builderInfo(`Scene ${i + 1} has no natural place to split (no second sentence or comma) – edit its text instead.`);
      rows[i].narration = a;
      rows.splice(i + 1, 0, { narration: rest, prompt: '', chapter: '' });
    } else if (b.dataset.a === 'del') {
      rows.splice(i, 1);
    }
    save();
    renderBuilder();
  });

  $('sbAdd').onclick = () => {
    builder().rows.push({ narration: '', prompt: '', chapter: '' });
    renderBuilder();
    const areas = $('sbRows').querySelectorAll('textarea[data-f="narration"]');
    if (areas.length) areas[areas.length - 1].focus();
  };

  $('sbSave').onclick = async () => {
    const name = `${safeName()}.txt`;
    const blob = new Blob([rowsToSceneFile(builder().rows.filter((r) => r.narration.trim()))], { type: 'text/plain' });
    try {
      let dir = canPickFolder ? await folderReady(true) : null;
      if (!dir && canPickFolder) dir = await chooseFolder().catch(() => null);
      if (dir) {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        builderInfo(`Saved ${name} in your save folder "${dir.name}".`);
        return log(`Scene Builder: saved ${name} in "${dir.name}"`);
      }
    } catch (e) {
      log(`Scene Builder: folder save failed (${e.message}) – using Chrome Downloads`);
    }
    const folder = state.settings.folder.replace(/[\\:*?"<>|]/g, '_');
    const res = await chrome.runtime.sendMessage({ type: 'download', url: await blobToDataUrl(blob), filename: `${folder}/${name}` });
    builderInfo(res && res.ok ? `Saved ${name} in Downloads/${folder}.` : `Save failed: ${res && res.error}`);
  };

  $('sbUse').onclick = () => {
    const rows = builder().rows.filter((r) => r.narration.trim());
    if (!rows.length || state.running) return;
    state.prompts = rows.map((r) => ({
      narration: r.narration.trim().replace(/\|/g, '/'),
      text: (r.prompt.trim() || r.narration.trim()).replace(/\|/g, '/'),
      chapter: r.chapter.trim(),
      status: 'pending',
      images: 0
    }));
    state.fileName = `${safeName()}.txt`;
    state.runFolder = '';
    rawFileText = '';
    save();
    render();
    closeBuilder();
    const custom = rows.filter((r) => r.prompt.trim()).length;
    log(`Scene Builder: ${rows.length} scenes ready (${custom} with their own picture) – press Start`);
  };

  // Keep Flow's own keyboard shortcuts from reacting while you type in the panel.
  for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
    host.addEventListener(type, (e) => e.stopPropagation());
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
  $('retry').onclick = async () => {
    // Only the failed ones: start() skips prompts that are done; "not saved" ones are
    // downloaded again instead of generated again.
    state.prompts.forEach((p) => {
      if (p.status === 'error' || p.status === 'timeout') p.status = 'pending';
    });
    state.recoverRound = 0;
    save();
    if (state.settings.autoDownload && canPickFolder) {
      try {
        await folderReady(true);
      } catch {
        /* falls back to Chrome Downloads */
      }
    }
    log('Retrying the failed prompts…');
    start();
  };
  $('reset').onclick = () => {
    state.prompts.forEach((p) => {
      p.status = 'pending';
      p.images = 0;
      p.files = [];
      p.found = [];
    });
    state.claimed = [];
    state.recoverRound = 0;
    save();
    render();
  };
  $('check').onclick = () => checkFolder(false).catch((e) => log(`Folder check: ${e.message}`));
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
        input.type === 'checkbox' ? input.checked
          : input.type === 'number' ? (input.value === '' || isNaN(Number(input.value)) ? DEFAULTS[k] : Number(input.value))
          : input.value.trim();
      save();
    };
  }
  $('min').onclick = () => {
    const panel = root.querySelector('.panel');
    panel.classList.toggle('collapsed');
    $('min').textContent = panel.classList.contains('collapsed') ? '+' : '–';
  };
  $('close').onclick = () => (host.style.display = 'none');

  // Drag the panel by its title bar. The place is remembered and kept on screen when
  // the window size changes; double-click the title bar to put it back in the corner.
  const panelEl = root.querySelector('.panel');
  function placePanel(pos) {
    if (!pos) {
      panelEl.classList.remove('moved');
      panelEl.style.left = panelEl.style.top = panelEl.style.maxHeight = '';
      return;
    }
    const w = panelEl.getBoundingClientRect().width;
    const x = Math.min(Math.max(8, pos.x), Math.max(8, innerWidth - w - 8));
    const y = Math.min(Math.max(8, pos.y), Math.max(8, innerHeight - Math.min(320, innerHeight - 16)));
    panelEl.classList.add('moved');
    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
    panelEl.style.maxHeight = `${innerHeight - y - 8}px`;
  }
  root.querySelector('.head').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = panelEl.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => placePanel({ x: ev.clientX - dx, y: ev.clientY - dy });
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (panelEl.classList.contains('moved')) {
        state.settings.panelPos = { x: parseFloat(panelEl.style.left), y: parseFloat(panelEl.style.top) };
        save();
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });
  root.querySelector('.head').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    state.settings.panelPos = null;
    placePanel(null);
    save();
  });
  addEventListener('resize', () => state.settings.panelPos && placePanel(state.settings.panelPos));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle') host.style.display = host.style.display === 'none' ? '' : 'none';
  });

  // Test hook (only when a test harness sets window.__flowBatchTest before loading).
  if (window.__flowBatchTest) Object.assign(window.__flowBatchTest, { state, ensureReferences, findPromptBox, findGenerateButton, refThumbs, liveCard, flowImageCount });

  document.documentElement.appendChild(host);
  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  $('ver').textContent = version ? `v${version}` : '';
  load().then(() => {
    if (state.settings.panelPos) placePanel(state.settings.panelPos);
    render();
    renderFolder();
    log(`Flow Batch v${version} ready (screen ${window.innerWidth}×${window.innerHeight})`);
    if (state.prompts.length) log(`Restored ${state.prompts.length} prompts from last session`);
    if (state.resumeAfterReload) autoResume();
  });

  // After an automatic reload (see recover): wait for Flow, then continue the run.
  async function autoResume() {
    state.resumeAfterReload = false;
    save();
    log('Page reloaded after Flow errors – continuing by itself…');
    if (!(await waitFor(() => findPromptBox(), 60000))) {
      log('Flow did not come back (no prompt box). Press Start when Flow works again.');
      return;
    }
    // The save folder must still be writable, or images would land somewhere else.
    if (state.settings.autoDownload && canPickFolder && (await IDB.get('dir').catch(() => null)) && !(await folderReady(false))) {
      log('Chrome needs you to confirm the save folder again – press Start (Resume) to continue.');
      return;
    }
    await sleep(3000);
    start();
  }
})();
