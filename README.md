# Flow Batch

Chrome extension that runs a `.txt` list of prompts through Google Flow
(https://flow.google.com) one after another – optionally with 1–2 reference
images attached to every prompt – and saves every generated image into a
folder you choose. After you press Start, nothing needs you until it's done.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `flow-batch` folder.
4. Pin the extension (puzzle icon → pin) so its icon is on the toolbar.

## Use

1. Open Flow, sign in, open or create a project, and switch the prompt bar to
   **image** generation with the model / aspect ratio / count you want.
   The extension only types and submits prompts – it uses whatever settings
   are selected in Flow.
2. The **Flow Batch** panel appears bottom-right (click the toolbar icon to
   show/hide it).
3. Click **Load .txt file…** and choose your prompt file:
   - *One prompt per line* (default) – lines starting with `#` are skipped.
   - *Separated by blank line* – for long, multi-line prompts.
4. Optional: **Reference images…** – pick 1 or 2 images. They're attached to
   Flow's prompt bar for every prompt (re-attached automatically if Flow
   clears them after a generation). Remove one with its ×.
5. **Save folder…** – pick (or create) the folder for the results. Chrome asks
   once to allow saving there; after that every image is written silently,
   with no "Save as" boxes. If you skip this, Start asks for it.
6. Optional: open **Advanced → Test detection**. The prompt box and generate
   button get a red outline for a few seconds so you can check they're right.
7. Click **Start**. For each prompt it attaches the references, types the
   text, clicks generate, waits for the new images, saves them, waits a few
   seconds, then moves on – until the whole list is done.

Each run gets its own sub-folder inside your save folder, named after the
prompt file and the start time, e.g.
`<save folder>/prompts_2026-10-24_1530/001_<prompt-words>_1.png`, `002_...`.
(Resume keeps writing into the same sub-folder.)

If a reference image can't be attached, the run stops instead of generating
images without it, so no credits are wasted.

Progress is remembered: if the page reloads, the list comes back and **Resume**
continues from the first prompt not yet done. **Reset** marks everything as
not done again.

## Make a video (images + audio)

`video-maker/Make Video.bat` turns a run folder into a 1920×1080 MP4 for
YouTube: the images in file-name order, each shown for an equal share of
one audio file (voice-over or music).

1. Install FFmpeg once: `winget install Gyan.FFmpeg`
2. Double-click **Make Video.bat**.
3. Pick the images folder and the audio file, click **Make video**.

The MP4 is saved inside the images folder, named after it. By default only
the first image of each prompt is used (`001_…_1`; if you deleted it, `_2`
is used) – untick the option to use every image. Images of other sizes get
white (or black) borders.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Images per prompt | 1 | Set to Flow's output count; the prompt finishes as soon as this many new images appear |
| Wait between prompts | 5 s | Pause before sending the next prompt |
| Done when no new image for | 10 s | Fallback if fewer images arrive than expected |
| Give up after | 240 s | Mark the prompt ⚠️ and move on |

## If it can't find the prompt box or button

Flow changes its page from time to time. If **Test detection** shows NOT FOUND
or outlines the wrong thing:

1. Right-click the prompt box in Flow → **Inspect**.
2. Right-click the highlighted element in DevTools → **Copy → Copy selector**.
3. Paste it into **Advanced → Prompt box CSS selector**. Do the same for the
   generate button if needed.

## Notes

- Flow ignores clicks made by page scripts, so the extension sends real
  clicks/key presses through Chrome's debugger interface. While a batch runs,
  Chrome shows a bar saying **"Flow Batch started debugging this browser"** –
  leave it (pressing Cancel stops the clicks). It disappears when the run ends.
  Don't open DevTools on the Flow tab during a run.
- References are uploaded the way a person would (+ → Upload); the extension
  answers Flow's file dialog itself, so no Windows file picker appears.
- After a browser restart Chrome may ask once (on Start) to allow saving to
  the folder again – choose "Allow on every visit" so it stops asking.

- Each generation uses your Flow credits/quota, same as clicking by hand.
- Keep the Flow tab open (it can be in the background, but don't close it).
- Pause holds the run after the current prompt finishes; Stop ends it.
