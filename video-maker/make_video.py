"""Flow Batch – Make Video.

Turns a folder of images + one narration file into a 1920x1080 MP4 for YouTube.

* With a script (.txt, one line of narration per image, same order as the
  images): the narration is transcribed on this PC (Whisper) and every image
  appears exactly when its line starts being spoken.
* Without a script: each image gets an equal share of the audio.

Double-click "Make Video.bat" (or run: python make_video.py).
Needs FFmpeg (winget install Gyan.FFmpeg) and, for narration matching,
faster-whisper (pip install faster-whisper).
"""

import csv
import difflib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_TYPES = [("Audio", "*.mp3 *.wav *.m4a *.aac *.ogg *.flac"), ("All files", "*.*")]
SCRIPT_TYPES = [("Text", "*.txt"), ("All files", "*.*")]
WIDTH, HEIGHT, FPS = 1920, 1080, 30
WHISPER_MODEL = "small"   # ~480 MB, downloaded once; multilingual
LEAD_IN = 0.15            # show the image this many seconds before its first word
MIN_SCENE = 0.5           # never show an image for less than this
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # hide ffmpeg console windows


# ---------- ffmpeg ----------

def find_tool(name):
    """Find ffmpeg/ffprobe on PATH or where winget puts it."""
    found = shutil.which(name)
    if found:
        return found
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [local / "Microsoft" / "WinGet" / "Links" / f"{name}.exe"]
    candidates += sorted((local / "Microsoft" / "WinGet" / "Packages").glob(f"Gyan.FFmpeg*/**/bin/{name}.exe"))
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def audio_duration(ffprobe, audio):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(audio)],
        capture_output=True, text=True, creationflags=NO_WINDOW,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        raise RuntimeError(f"Could not read the length of the audio file.\n{out.stderr.strip()}")


# ---------- images ----------

def natural_key(path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", path.name)]


def pick_images(folder, first_per_prompt):
    images = sorted((p for p in Path(folder).iterdir() if p.suffix.lower() in IMAGE_EXT), key=natural_key)
    if not first_per_prompt:
        return images
    # Flow Batch names files 001_<words>_1.png, 001_<words>_2.png … – keep one per prompt number.
    chosen, seen = [], set()
    for p in images:
        m = re.match(r"(\d+)_", p.name)
        key = m.group(1) if m else p.name
        if key not in seen:
            seen.add(key)
            chosen.append(p)
    return chosen


def read_script(path):
    """Narration lines. Scene-file lines "narration | image prompt" keep only the narration."""
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
    return [line.split("|", 1)[0].strip() if "|" in line else line for line in lines]


def scene_number(path):
    m = re.match(r"(\d+)_", path.name)
    return int(m.group(1)) if m else None


def find_script(folder, script):
    """The script picked by hand, else the scenes.txt Flow Batch saved in the folder."""
    if script:
        return Path(script)
    auto = Path(folder) / "scenes.txt"
    return auto if auto.is_file() else None


def plan_scenes(folder, first_per_prompt, script=None):
    """Pair images with narration lines.

    Returns a dict: script (Path or None), lines (narration per scene or None),
    scenes (list of image lists, one per scene), missing (scene numbers with no
    image), extra (images with no scene).
    """
    images = pick_images(folder, first_per_prompt)
    path = find_script(folder, script)
    if not path:
        return {"script": None, "lines": None, "scenes": [[p] for p in images], "missing": [], "extra": []}
    lines = read_script(path)
    numbered = [p for p in images if scene_number(p)]
    if numbered:
        # Flow Batch file names start with the scene number: 001_…, 002_… – match by number,
        # so a failed or deleted image can't shift every later image. Images without a
        # number (a thumbnail, a screenshot…) are left out.
        scenes, extra = [[] for _ in lines], [p for p in images if not scene_number(p)]
        for p in numbered:
            n = scene_number(p)
            (scenes[n - 1] if 1 <= n <= len(lines) else extra).append(p)
    else:
        if len(images) != len(lines):
            raise RuntimeError(
                f"The script has {len(lines)} lines but there are {len(images)} images, and the image "
                "names don't start with scene numbers (001_…), so they can't be paired."
            )
        scenes, extra = [[p] for p in images], []
    missing = [i + 1 for i, s in enumerate(scenes) if not s]
    if len(missing) == len(scenes):
        raise RuntimeError("None of the scenes has an image – is this the right folder for this script?")
    return {"script": path, "lines": lines, "scenes": scenes, "missing": missing, "extra": extra}


# ---------- narration matching ----------

def tokens(text):
    return re.findall(r"\w+", text.lower())


def load_audio_16k(ffmpeg, audio):
    """Decode any audio file to 16 kHz mono float samples (what Whisper expects).

    Done with FFmpeg rather than faster-whisper's own reader, which breaks
    whenever its PyAV dependency changes its interface.
    """
    import numpy as np

    r = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(audio), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True, creationflags=NO_WINDOW,
    )
    if r.returncode != 0:
        raise RuntimeError(f"Could not read the narration audio:\n{r.stderr.decode(errors='replace')[-800:]}")
    return np.frombuffer(r.stdout, dtype=np.float32)


def transcribe_words(ffmpeg, audio, total, on_progress, on_status):
    """Return [(token, start_seconds)] for every spoken word."""
    # The model download's newer "xet" transfer can stall on some connections;
    # plain HTTP is resumable and reliable.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError("Narration matching needs the speech-recognition library.\n\nInstall it once by running this in a terminal:\n\npip install faster-whisper")
    on_status("Loading the speech model (the first time it downloads ~480 MB)…")
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    on_status("Listening to the narration…")
    samples = load_audio_16k(ffmpeg, audio)
    segments, _info = model.transcribe(samples, word_timestamps=True, vad_filter=True)
    out = []
    for seg in segments:
        for w in seg.words or []:
            for tok in tokens(w.word):
                out.append((tok, w.start))
        on_progress(min(1.0, seg.end / total))
    return out


def scene_starts(lines, spoken, total):
    """Find when each script line starts in the narration.

    Aligns the script's words with the transcribed words (tolerant of small
    differences), then takes the time of each line's first matched word.
    Returns (starts, matched_fraction).
    """
    s_tok, s_line = [], []
    for i, line in enumerate(lines):
        for t in tokens(line):
            s_tok.append(t)
            s_line.append(i)
    t_tok = [t for t, _ in spoken]
    t_time = [s for _, s in spoken]

    sm = difflib.SequenceMatcher(None, s_tok, t_tok, autojunk=False)
    when = {}
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            when[a + k] = t_time[b + k]

    starts = []
    for i in range(len(lines)):
        idx = [j for j, li in enumerate(s_line) if li == i]
        first = next((j for j in idx if j in when), None)
        if first is None:
            starts.append(None)
        else:
            # If the line's first words weren't recognised, step back ~0.35 s per word.
            starts.append(max(0.0, when[first] - 0.35 * (first - idx[0]) - LEAD_IN))

    # Lines with no recognised words: place them evenly between their neighbours.
    known = [(i, s) for i, s in enumerate(starts) if s is not None]
    if not known:
        raise RuntimeError("None of the script's words were found in the narration – is it the right script for this audio?")
    for i, s in enumerate(starts):
        if s is None:
            prev = max(((j, t) for j, t in known if j < i), default=(-1, 0.0))
            nxt = min(((j, t) for j, t in known if j > i), default=(len(lines), total))
            starts[i] = prev[1] + (nxt[1] - prev[1]) * (i - prev[0]) / (nxt[0] - prev[0])

    # First image from the very start; keep order and a minimum length per image.
    starts[0] = 0.0
    for i in range(1, len(starts)):
        starts[i] = max(starts[i], starts[i - 1] + MIN_SCENE)
    for i in range(len(starts) - 1, 0, -1):  # don't run past the end of the audio
        starts[i] = min(starts[i], total - MIN_SCENE * (len(starts) - i))
    return starts, len(when) / max(1, len(s_tok))


# ---------- build ----------

def build_video(plan, audio, output, background, on_progress, on_status=lambda s: None):
    """Make the MP4 from plan_scenes(). Returns (total_seconds, durations, note)."""
    ffmpeg, ffprobe = find_tool("ffmpeg"), find_tool("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("FFmpeg is not installed.\n\nInstall it once by running this in a terminal:\n\nwinget install Gyan.FFmpeg\n\nthen open this tool again.")

    total = audio_duration(ffprobe, audio)
    scenes, lines = plan["scenes"], plan["lines"]
    note = ""
    if lines:
        # Progress: 0–50 % listening, 50–65 % images, 65–100 % video.
        spoken = transcribe_words(ffmpeg, audio, total, lambda f: on_progress(0.5 * f), on_status)
        starts, matched = scene_starts(lines, spoken, total)
        note = f"{matched:.0%} of the script's words were found in the narration."
        if matched < 0.5:
            note += " That is low – check that the script matches this audio."
        p0, p_img = 0.5, 0.15
    else:
        lines = [""] * len(scenes)
        starts = [total * i / len(scenes) for i in range(len(scenes))]
        p0, p_img = 0.0, 0.3
    scene_len = [b - a for a, b in zip(starts, starts[1:] + [total])]

    # Turn scenes into shots (image, start, seconds). A scene without an image keeps
    # the previous image on screen; several images in one scene share its time.
    shots, carry = [], 0.0
    for imgs, s, d in zip(scenes, starts, scene_len):
        if not imgs:
            if shots:
                img, s0, d0 = shots[-1]
                shots[-1] = (img, s0, d0 + d)
            else:
                carry += d  # missing first scene(s): the first image starts at 0
            continue
        s, d = s - carry, d + carry
        carry = 0.0
        for k, img in enumerate(imgs):
            shots.append((img, s + d * k / len(imgs), d / len(imgs)))
    images = [img for img, _, _ in shots]
    durations = [d for _, _, d in shots]

    # Timing sheet next to the video, to check or share.
    with open(output.with_name(output.stem + "_timings.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["scene", "image", "starts_at", "seconds", "narration"])
        for i, (imgs, s, d, line) in enumerate(zip(scenes, starts, scene_len, lines), 1):
            name = " + ".join(p.name for p in imgs) or "(no image - previous one stays)"
            w.writerow([i, name, f"{int(s // 60)}:{s % 60:05.2f}", f"{d:.2f}", line])

    on_status(f"Preparing {len(images)} images…")
    with tempfile.TemporaryDirectory(prefix="flowbatch_") as tmp:
        tmp = Path(tmp)

        # Bring every image to exactly 1920x1080 with borders. Joining images of
        # different sizes directly makes FFmpeg drop frames, so they must match first.
        fit = (
            f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:color={background},setsar=1"
        )
        frames = []
        for i, img in enumerate(images):
            frame = tmp / f"{i:05d}.png"
            r = subprocess.run(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(img), "-vf", fit, "-frames:v", "1", str(frame)],
                capture_output=True, text=True, creationflags=NO_WINDOW,
            )
            if r.returncode != 0:
                raise RuntimeError(f"Could not read image {img.name}:\n{r.stderr.strip()[-800:]}")
            frames.append(frame)
            on_progress(p0 + p_img * (i + 1) / len(images))

        # ffmpeg "concat" list – each frame with its duration (last one repeated, as ffmpeg requires).
        lines_txt = []
        for frame, d in zip(frames, durations):
            lines_txt += [f"file '{frame.as_posix()}'", f"duration {d:.4f}"]
        lines_txt.append(f"file '{frames[-1].as_posix()}'")
        list_file = tmp / "list.txt"
        list_file.write_text("\n".join(lines_txt), encoding="utf-8")

        on_status("Making the video…")
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-i", str(audio),
            "-vf", f"fps={FPS},format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-tune", "stillimage",
            "-c:a", "aac", "-b:a", "192k",
            "-t", f"{total:.3f}", "-movflags", "+faststart",
            str(output),
        ]
        start = p0 + p_img
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
        for line in proc.stdout:
            if line.startswith("out_time_us="):
                try:
                    on_progress(start + (1 - start) * min(1.0, int(line.split("=")[1]) / 1e6 / total))
                except ValueError:
                    pass
        err = proc.stderr.read()
        if proc.wait() != 0:
            raise RuntimeError(f"FFmpeg failed:\n{err.strip()[-1500:]}")
    return total, durations, note


# ---------- window ----------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Flow Batch – Make Video")
        self.resizable(False, False)
        self.folder = tk.StringVar()
        self.audio = tk.StringVar()
        self.script = tk.StringVar()
        self.first_only = tk.BooleanVar(value=True)
        self.bg = tk.StringVar(value="white")
        self.status = tk.StringVar(value="Pick the images folder and the narration audio.")

        pad = {"padx": 10, "pady": 5}
        frm = ttk.Frame(self, padding=12)
        frm.grid()

        ttk.Label(frm, text="1. Images folder").grid(row=0, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.folder, width=55).grid(row=0, column=1, **pad)
        ttk.Button(frm, text="Browse…", command=self.pick_folder).grid(row=0, column=2, **pad)

        ttk.Label(frm, text="2. Narration audio").grid(row=1, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.audio, width=55).grid(row=1, column=1, **pad)
        ttk.Button(frm, text="Browse…", command=self.pick_audio).grid(row=1, column=2, **pad)

        ttk.Label(frm, text="3. Script (optional)").grid(row=2, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.script, width=55).grid(row=2, column=1, **pad)
        ttk.Button(frm, text="Browse…", command=self.pick_script).grid(row=2, column=2, **pad)
        ttk.Label(frm, text="Not needed if the folder has scenes.txt from Flow Batch. "
                            "No script at all = equal timing.",
                  foreground="#666").grid(row=3, column=1, columnspan=2, sticky="w", padx=10)

        opts = ttk.Frame(frm)
        opts.grid(row=4, column=0, columnspan=3, sticky="w", **pad)
        ttk.Checkbutton(opts, text="Only the first image of each prompt (001_…_1)", variable=self.first_only,
                        command=self.refresh_count).pack(side="left")
        ttk.Label(opts, text="   Border colour:").pack(side="left")
        ttk.Combobox(opts, textvariable=self.bg, values=["white", "black"], width=7, state="readonly").pack(side="left")

        self.count = ttk.Label(frm, text="")
        self.count.grid(row=5, column=0, columnspan=3, sticky="w", **pad)

        self.bar = ttk.Progressbar(frm, length=560, maximum=1.0)
        self.bar.grid(row=6, column=0, columnspan=3, **pad)
        ttk.Label(frm, textvariable=self.status, wraplength=560).grid(row=7, column=0, columnspan=3, sticky="w", **pad)

        self.go = ttk.Button(frm, text="Make video", command=self.start)
        self.go.grid(row=8, column=0, columnspan=3, pady=(6, 2))

        if not find_tool("ffmpeg"):
            self.status.set("FFmpeg is not installed – run  winget install Gyan.FFmpeg  once, then reopen this tool.")

    def pick_folder(self):
        d = filedialog.askdirectory(title="Folder with the images")
        if d:
            self.folder.set(d)
            self.refresh_count()

    def pick_audio(self):
        f = filedialog.askopenfilename(title="Narration audio", filetypes=AUDIO_TYPES)
        if f:
            self.audio.set(f)

    def pick_script(self):
        f = filedialog.askopenfilename(title="Narration script (one line per image)", filetypes=SCRIPT_TYPES)
        if f:
            self.script.set(f)
            self.refresh_count()

    def describe(self, plan):
        n_img = sum(len(s) for s in plan["scenes"])
        if not plan["script"]:
            return f"{n_img} image(s), no script – each image gets an equal share of the audio."
        src = "scenes.txt in the folder" if plan["script"].name == "scenes.txt" and not self.script.get() else plan["script"].name
        text = f"{len(plan['scenes'])} scenes (from {src}), {n_img} image(s)."
        if plan["missing"]:
            text += f"  ✗ No image for scene(s) {', '.join(map(str, plan['missing']))}."
        else:
            text += "  ✓ Every scene has an image."
        if plan["extra"]:
            text += f"  {len(plan['extra'])} other image(s) don't belong to a scene and are left out."
        return text

    def refresh_count(self):
        if not (self.folder.get() and Path(self.folder.get()).is_dir()):
            return
        try:
            self.count.config(text=self.describe(plan_scenes(self.folder.get(), self.first_only.get(), self.script.get().strip() or None)))
        except Exception as e:
            self.count.config(text=f"✗ {e}")

    def start(self):
        folder, audio, script = self.folder.get(), self.audio.get(), self.script.get().strip()
        if not folder or not Path(folder).is_dir():
            return messagebox.showwarning("Make Video", "Pick the images folder first.")
        if not audio or not Path(audio).is_file():
            return messagebox.showwarning("Make Video", "Pick the narration audio first.")
        if script and not Path(script).is_file():
            return messagebox.showwarning("Make Video", "The script file wasn't found.")
        try:
            plan = plan_scenes(folder, self.first_only.get(), script or None)
        except Exception as e:
            return messagebox.showerror("Make Video", str(e))
        if not any(plan["scenes"]):
            return messagebox.showwarning("Make Video", "No images (.png/.jpg/.webp) in that folder.")
        if plan["missing"]:
            gaps = ", ".join(map(str, plan["missing"]))
            if not messagebox.askyesno(
                "Make Video",
                f"Scene(s) {gaps} have no image (failed or deleted).\n\n"
                "Make the video anyway? The previous image stays on screen during those scenes.\n\n"
                "Or click No, use \"Retry failed\" in Flow Batch, and come back.",
            ):
                return
        output = Path(folder) / f"{Path(folder).name}.mp4"
        images = [p for s in plan["scenes"] for p in s]
        script = plan["script"]

        self.go.config(state="disabled")
        self.bar["value"] = 0

        def progress(frac):
            self.after(0, lambda: self.bar.configure(value=frac))

        def status(text):
            self.after(0, lambda: self.status.set(text))

        def work():
            try:
                total, durations, note = build_video(plan, audio, output, self.bg.get(), progress, status)
                mode = "matched to the narration" if script else "equal timing"
                msg = (f"Done! {output}\n{len(images)} images, {total:.0f} s, {mode} "
                       f"(shortest {min(durations):.1f} s, longest {max(durations):.1f} s). {note}\n"
                       f"Timing sheet: {output.stem}_timings.csv")
                self.after(0, lambda: self.finish(msg, output))
            except Exception as e:  # show any failure in the window
                err = str(e)
                self.after(0, lambda: self.finish(err, None))

        threading.Thread(target=work, daemon=True).start()

    def finish(self, msg, output):
        self.go.config(state="normal")
        self.status.set(msg)
        if output:
            self.bar["value"] = 1.0
            if messagebox.askyesno("Make Video", f"{msg}\n\nOpen the folder?"):
                os.startfile(output.parent)
        else:
            messagebox.showerror("Make Video", msg)


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    App().mainloop()
