# Flow Batch

Chrome extension that runs a `.txt` list of prompts through Google Flow
(https://flow.google.com) one after another and can save every
generated image to your Downloads folder.

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
4. Optional: open **Advanced → Test detection**. The prompt box and generate
   button get a red outline for a few seconds so you can check they're right.
5. Click **Start**. For each prompt it types the text, presses generate, waits
   for the new images, downloads them, waits a few seconds, then moves on.

Images are saved as
`Downloads/FlowBatch/001_<prompt-words>_1.png`, `001_..._2.png`, `002_...` etc.
Turn off Chrome's "Ask where to save each file" setting, or you'll get a save
dialog for every image.

Progress is remembered: if the page reloads, the list comes back and **Resume**
continues from the first prompt not yet done. **Reset** marks everything as
not done again.

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

- Each generation uses your Flow credits/quota, same as clicking by hand.
- Keep the Flow tab open (it can be in the background, but don't close it).
- Pause holds the run after the current prompt finishes; Stop ends it.
