# Test pack

A small, complete example to practise with – **no Flow credits needed** for
exercise 1.

| File | What it is |
|---|---|
| `001_…png` … `009_…png` | 9 scene images, named exactly like Flow Batch names them. Each shows **SCENE n** and its narration line, so you can see the timing while watching |
| `scenes.txt` | The scene file Flow Batch writes into a run folder: narration \| picture per scene, with 3 `## chapters` |
| `narration.mp3` | 47 s of narration (Windows' computer voice) reading the 9 scenes in order |
| `music.mp3` | A soft 16 s music loop, to try the background-music option |
| `script.txt` | The same narration as a **plain script** (no `\|`), to practise with Scene Builder |

**First copy this whole `test-pack` folder to your Desktop** and work on the
copy – so test videos aren't created inside the repository.

---

## Exercise 1 – Make a video (Make Video only)

This folder is exactly what Flow Batch leaves after a run, so you can go
straight to the video step.

1. Double-click **`video-maker\Make Video.bat`**.
2. **Images folder** → your copy of `test-pack`.
3. **Narration audio** → `narration.mp3` from the copy.
4. **Script** → leave empty (it reads `scenes.txt` from the folder).
5. Check the line under the options says:
   *"9 scenes (from scenes.txt in the folder), 9 image(s). 3 chapter title(s).
   ✓ Every scene has an image."*
6. Optional: **Background music** → `music.mp3` (volume *Quiet*), and tick
   **Slow zoom on images** and **Subtitles on the video**.
7. Click **Make video** (about 1–2 minutes).

**What you should get** (in the copy folder):

- **`test-pack.mp4`** – each "SCENE n" card appears just as its sentence
  starts. Expected times (± half a second):

  | Scene | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
  |---|---|---|---|---|---|---|---|---|---|
  | Appears at | 0:00 | 0:07 | 0:12 | 0:18 | 0:24 | 0:28 | 0:34 | 0:37 | 0:42 |

  With music: you hear it in the pauses, and it gets quieter while the voice
  speaks. With zoom: each card slowly zooms in or out. With subtitles: small
  white text along the bottom, e.g. *"Today we follow a small cargo"*.
- **`test-pack.srt`** – subtitles, e.g. *"Welcome aboard."*, *"Today we follow a
  small cargo"*, *"ship across the ocean."*
- **`test-pack_youtube.txt`** – the chapter list:
  `0:00 Leaving port`, `0:18 The storm`, `0:33 Safe arrival`
- **`test-pack_timings.csv`** – when each scene starts and how long it stays.

**Also try – a missing image:** delete `005_…png` from your copy and run
again. The tool reports *"No image for scene(s) 5"*; click **Yes** – SCENE 4
then stays on screen until scene 6 starts.

---

## Exercise 2 – Scene Builder (in Flow)

Practise turning a plain script into scenes. Only **Start** uses Flow credits –
you can stop before that.

1. Open your Flow project; in the Flow Batch panel click **Scene Builder…**.
2. Open `script.txt` in Notepad, copy everything, paste it into the top box.
3. **Scene length** → *Short*, **Video name** → `test`, click **Split into
   scenes**.
4. You should get the same **9 scenes and 3 chapters** as in `scenes.txt`.
   Try **↑ Merge**, **✂ Split**, and typing a picture in a **Picture** box.
5. **Save .txt** saves your scene file; **Use these scenes** puts them in the
   panel list. (Press **Start** only if you want to generate real images.)
