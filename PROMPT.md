# Prompt: continue building "Flow Batch" (Chrome extension for Google Flow)

Copy everything below the line into an AI coding assistant, together with the
current source files (manifest.json, background.js, content.js, README.md).

---

You are a senior Chrome-extension engineer. Help me extend and harden an
existing Manifest V3 Chrome extension called **Flow Batch**. Read the current
code I've attached first, keep everything that already works, and change it in
small, testable steps. Explain each change briefly and give me complete files
(not fragments) when you edit them.

## What the extension does today

Flow Batch automates Google Flow (the AI image/video tool, now at
`https://flow.google.com/`, previously `https://labs.google/fx/tools/flow`).
The user uploads a `.txt` file of prompts (plus optionally 1–2 reference
images and a save folder, chosen once); the extension runs them one by one in
the open Flow project, with no human interaction after pressing Start:

0. Ensures the reference images are attached in Flow's prompt bar (re-attaches
   them if Flow cleared them). Attach methods, last-successful first:
   (a) an `<input type=file>` near the prompt bar via DataTransfer,
   (b) trusted click on "+" → "Upload" with CDP
   `Page.setInterceptFileChooserDialog` – on `Page.fileChooserOpened` the
   background resolves the input (`DOM.resolveNode`) and fills it via
   `Runtime.callFunctionOn` (no native dialog), (c) synthetic drag-and-drop.
   Success = thumbnails ≥28 px appear in the prompt card; confirms a crop/
   confirm dialog if one appears. If attaching fails the run stops (no
   credits wasted on wrong results).
1. Types the prompt into Flow's prompt box ("What do you want to create?").
2. Clicks Flow's → generate button (right end of the prompt bar, next to the
   model chip, e.g. "Nano Banana Pro x1").
3. Confirms Flow accepted the prompt, waits for the generated image(s).
4. Saves the new images silently with the File System Access API into the
   folder the user picked once (handle kept in IndexedDB; permission
   re-requested on the Start click if needed), in a per-run sub-folder
   `<promptfile>_<YYYY-MM-DD_HHMM>/NNN_<slug>_K.png`. Images are fetched in
   the content script, or via the background (`fetchDataUrl`) if CORS blocks
   it. Fallback when no folder: chrome.downloads to `Downloads/FlowBatch/…`.
5. Waits a configurable delay, then moves to the next prompt.

### Files
- **manifest.json** – MV3. Permissions: `storage`, `downloads`, `debugger`.
  Host permissions: `flow.google.com`, `labs.google`, `*.googleusercontent.com`,
  `storage.googleapis.com`. Content script `content.js` on
  `https://flow.google.com/*` and `https://labs.google/fx/*`. Toolbar action
  toggles the panel (or opens Flow if the tab isn't Flow).
- **background.js** – service worker. Handles messages:
  `download` (chrome.downloads, `conflictAction: 'uniquify'`),
  `trustedClick {x,y}` and `trustedEnter` (sent via `chrome.debugger` +
  CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`), and `detach`.
  Tracks attached tabs; tolerates "already attached".
- **content.js** – everything on the page:
  - Floating panel in a **shadow DOM** (bottom-right, dark theme): load .txt,
    split mode (one prompt per line, `#` = comment / or blank-line separated),
    prompt list with status icons (○ pending, ⏳ running, ✅ done, ⚠️ timeout,
    ❌ error), progress bar, Start/Resume, Pause, Stop, Reset, Settings,
    Advanced (CSS selector overrides + "Test detection" that outlines the
    detected box/button and logs the button's HTML), and a log.
  - Settings (saved in `chrome.storage.local` with the prompt list, so a reload
    can Resume): imagesPerPrompt (1), delaySec (5), stableSec (10),
    timeoutSec (240), autoDownload (true), folder ("FlowBatch"),
    promptSelector, buttonSelector.
  - Prompt box detection: visible `textarea`, `[contenteditable=true]` or
    `[role=textbox]`, preferring one whose placeholder/aria-label matches
    prompt/describe/create/what do you want.
  - Typing: `document.execCommand('insertText')` after select-all (fires real
    beforeinput/input events React accepts); fallback native value setter.
  - Submit button: find the "composer" = nearest ancestor of the box with ≥2
    visible buttons; drop buttons labelled close/clear/cancel/remove/add/agent;
    prefer label match (generate/send/submit/arrow_forward/arrow_upward),
    else the right-most, lowest button.
  - Submission order: real CDP click → real CDP Enter → scripted pointer-event
    click → scripted Enter. After each attempt wait up to 6 s for proof
    (prompt box cleared, or ≥2 DOM nodes added/removed outside the composer
    and the panel, ignoring tooltips) before trying the next method, so the
    same prompt is never submitted twice.
  - Completion: snapshot all loaded `<img>` ≥256 px before submitting; done
    when `imagesPerPrompt` new images have appeared and been stable 2 s, or
    any new images stable for `stableSec`, or `timeoutSec` reached.
  - Downloads: blob: URLs are fetched and converted to data URLs in the
    content script; http(s)/data URLs are passed to the background.
  - Detaches the debugger when the run ends (removes Chrome's
    "started debugging this browser" bar).

### Hard-won lessons – do not regress these
1. **Flow ignores script-generated (untrusted) clicks and key presses.** Only
   CDP input via `chrome.debugger` (or a real user) submits the prompt.
2. In a shadow DOM, `event.target` is `null` after an `await` – keep a direct
   element reference instead.
2b. CDP clicks land on whatever is on top – set the panel host to
   `pointer-events: none` during each trusted click, or the panel can swallow
   the click when it overlaps Flow's button.
2d. Flow's real reference flow (verified Oct 2026): "+" = button
   `aria-label="Add ingredients to the prompt box"` opens a dialog
   `role=dialog aria-label="Add assets to the project"`; its
   `aria-label="Upload media"` button creates a hidden
   `<input type=file multiple>`; the upload lands in the asset list as
   `button[role=option].asset-item` with text "<filename> Image" (spinner /
   "Uploading" while busy) – it is NOT attached until that option is clicked,
   which closes the dialog and shows a 50×50 `<img>` in
   `flow-prompt-box-instruction-card-wrapper`. Already-uploaded assets are
   re-used by name. Submit button: `aria-label="Start generation"`; prompt box
   is a ProseMirror `[role=textbox]`; the "Settings trigger" chip text ends in
   `x<N>` = images per prompt. Media URLs are on `flow-content.google` (CORS:
   fetch them from the background script).
2c. `chrome.downloads` still shows "Save as" boxes when Chrome's "Ask where to
   save" setting is on – that's why saving uses the File System Access API.
3. Flow moved domains once; keep URL matching in one place and support both.
4. Never resubmit a prompt unless you are sure the previous attempt did
   nothing – each generation costs the user's credits.
5. Flow's DOM changes without notice: prefer structural/positional detection
   with user-overridable selectors over brittle class names.
6. Account safety: Google's terms restrict automated use. Keep the tool
   sequential (one generation at a time), human-paced, and easy to stop.
   Do not add features whose purpose is to hide automation or evade Google's
   detection or rate limits.

## Features to add (in priority order – ask me before starting each group)

### A. Reliability
1. **Full-resolution downloads** – the `<img>` src may be a preview. Use the
   tile's own Download/⋮ menu (via trusted clicks) or the original media URL,
   and verify the downloaded size.
2. **Track the exact new tile** for each prompt (the element Flow inserts after
   submit) instead of diffing all images; read its progress/failure state.
3. **Detect Flow messages** – policy/safety rejection, "out of credits",
   rate-limit, network error, sign-out. Mark the prompt with a clear reason;
   auto-pause the run on quota/rate-limit/sign-out.
4. **Retry policy** – configurable max retries per prompt for transient
   failures only (never for policy rejections); stop the run after N
   consecutive failures.
5. **Teach mode** – "Pick prompt box" / "Pick generate button": the next click
   on the page is captured and saved as a robust selector (data-attributes →
   aria-label → structural path), stored per domain.
6. **Health check before Start** – verify signed in, project open, box and
   button found, image mode selected; show a clear checklist.
7. **Screenshot on error** (`chrome.tabs.captureVisibleTab`) saved alongside
   the log.

### B. Productivity
1. **Richer input files** – accept `.txt`, `.csv` and `.json`. CSV/JSON
   columns: `prompt, filename, count, aspect_ratio, model, notes`. Per-row
   settings override the defaults (setting Flow's model/aspect/count via
   trusted clicks on its controls).
2. **Prompt templates** – global prefix/suffix and variables, e.g.
   `{color} denim jacket, {background}` expanded from lists (cartesian or
   zipped), with a preview count before running.
3. **Run report** – export CSV/JSON: index, prompt, status, reason, start/end
   time, duration, image count, saved file names. Auto-save next to the images.
4. **Editable queue** – reorder, edit, skip, duplicate, delete, re-run selected
   or only failed prompts; drag-and-drop file onto the panel.
5. **Human-like pacing controls** – min/max delay range (random within range),
   max prompts per run, daily cap, optional run window (e.g. 09:00–18:00),
   automatic long break every N prompts.
6. **Notifications** – desktop notification on finish/pause/error;
   optional sound.
7. **Per-run output folder** – `FlowBatch/<project or date>/<run name>/`.
8. **Settings profiles** – save/load named presets; import/export as JSON.

### C. Production quality
1. Restructure into modules with a build step (TypeScript + Vite or esbuild):
   `background/`, `content/automation`, `content/ui`, `shared/` (types,
   messages, storage schema with versioned migrations).
2. Move the UI to Chrome's **Side Panel API** (keeps the panel open and out of
   Flow's layout); keep an optional on-page mini status chip.
3. Typed message protocol between content and background; central error
   handling; log levels; export log.
4. Attach the debugger only around each trusted action (or keep attached for
   the run, configurable) and always detach on stop/error/tab close.
5. Tests: unit tests (Vitest) for parsing, templating, filename slugs, retry
   logic; a local **mock Flow page** that mimics the composer (ignores
   untrusted clicks, adds tiles after a delay, can simulate errors) and
   Playwright tests that load the unpacked extension against it.
6. Icons (16/32/48/128), version number shown in the panel, CHANGELOG.md,
   ESLint + Prettier, a `npm run build` that outputs `dist/` and a zip for
   distribution.
7. Accessibility and UX: keyboard shortcuts (Start/Pause/Stop), light/dark
   theme, clear empty/error states, confirmations before Reset and before
   runs larger than N prompts (show estimated credits/time).

## How to work
- Start by summarising the current code in 10 lines and proposing a plan for
  the group I choose. Wait for my OK.
- Keep the extension loadable as an unpacked extension after every step.
- After each step tell me exactly how to test it in Chrome
  (reload at chrome://extensions, refresh Flow, what to look for in the log).
- If you are unsure about Flow's current DOM, add logging / Test-detection
  output and ask me for a screenshot rather than guessing.
