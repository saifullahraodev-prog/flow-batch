# Scene-writer prompt

Turns your narration script into a finished **scene file** for Flow Batch in
one go – with Claude, ChatGPT or any similar assistant.

## How to use it

1. Copy everything inside the box below.
2. Fill in the two lines marked **✎** (your style and your recurring characters).
3. Paste your script at the very end, after `SCRIPT:`.
4. Send it. Copy the answer into Notepad and **Save as** `your-video.txt`
   (UTF-8).
5. Quick check before using it:
   - every line has exactly one `|`;
   - the left sides, read top to bottom, are your script word for word;
   - lines starting with `##` are chapter titles.
6. In Flow Batch: **Load .txt file…**, and put the same style text in the
   **Style box**.

**Long scripts** (more than ~1,500 words): send the script in parts of
~1,000 words, each time with the same prompt, and join the answers. If the
answer stops halfway, reply *"continue exactly where you stopped"*.

## The prompt

```text
You are helping me turn a YouTube narration script into a scene file for an image-generation tool.

OUTPUT FORMAT (strict)
- Plain text only: no explanations, no headings, no numbering, no code fences.
- One scene per line, written as:   narration | image prompt
- Start each chapter with its own line "## Chapter title" right before the chapter's first scene.
  Use 3 to 8 chapters with short titles (2 to 5 words). The first line of the answer is a "##" line.

NARRATION (left of the |)
- Copy my script WORD FOR WORD and in the same order. Do not change, add, shorten, reorder or drop
  anything - it must match my recorded voice-over exactly.
- Split it into scenes of usually 1-2 sentences, about 5-12 seconds of speech (roughly 12-30 words).
  Only split a long sentence at a natural pause (comma, "and", "but").
- Never use the | character inside the narration.

IMAGE PROMPT (right of the |)
- One clear, concrete picture of what is being said in that scene: who, doing what, where. 8-25 words.
- Do NOT describe the art style (no "cartoon", "illustration", "2D", "drawing", colours of the style) -
  the style is added automatically.
- Describe recurring characters and objects the SAME way every time (see the list below).
- No text, letters, numbers, signs, logos, captions or speech bubbles in the picture. No real people's
  names or brands.
- For abstract sentences, choose a simple visual metaphor a viewer understands instantly.
- Vary the shots (wide shot, close-up, from above, from the side) so neighbouring scenes don't look alike.

Before you answer, check that every word of my script appears exactly once, in order, on the left sides.

✎ My visual style (for your understanding only - do not write it in the prompts): 2D stickman cartoon, flat colours, white background
✎ Recurring characters and objects: the captain = a stickman with a blue captain's cap; the ship = a small red cargo ship with white containers

SCRIPT:
<paste your script here>
```

## Example

Script:

> In 1912 the Titanic left Southampton on her first voyage. The captain was
> proud of his ship. On a cold April night, the lookout saw an iceberg.

Answer:

```text
## Leaving port
In 1912 the Titanic left Southampton on her first voyage. | a huge four-funnel ocean liner leaving a busy harbour, crowds waving from the dock
The captain was proud of his ship. | the captain, a stickman with a white captain's cap, smiling on the deck with arms crossed
## The iceberg
On a cold April night, the lookout saw an iceberg. | a stickman lookout in the crow's nest at night pointing at a giant iceberg ahead
```
