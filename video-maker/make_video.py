"""Flow Batch – Make Video.

Turns a folder of images + one narration file into a 1920x1080 MP4 for YouTube.

* With a script (scenes.txt from Flow Batch, or any .txt with one line of
  narration per image): the narration is transcribed on this PC (Whisper) and
  every image appears exactly when its line starts being spoken. Subtitles
  (.srt) and a YouTube description with chapters are written too.
* Without a script: each image gets an equal share of the audio.
* Options: slow zoom on every image, quiet background music that dips while
  the narrator speaks.

Double-click "Make Video.bat" (or run: python make_video.py).
Needs FFmpeg (winget install Gyan.FFmpeg) and, for narration matching,
faster-whisper (pip install faster-whisper) – Setup.bat installs both.
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
ZOOM = 0.08               # slow zoom: 8 % in (or out) over each image
MUSIC_LEVELS = {"Quiet": 0.10, "Medium": 0.18, "Loud": 0.28}
SUB_MAX_CHARS = 42        # one subtitle line
SUB_MAX_SECONDS = 5.0
CHAPTER_MIN = 10          # YouTube: every chapter at least 10 s, at least 3 chapters
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


def audio_channels(ffprobe, audio):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "default=nw=1:nk=1", str(audio)],
        capture_output=True, text=True, creationflags=NO_WINDOW,
    )
    try:
        return int(out.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        return 2


def run_ffmpeg(cmd, total=None, on_fraction=None):
    """Run FFmpeg; report progress (0–1) from its -progress output when total is given."""
    if total and on_fraction:
        cmd = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
        for line in proc.stdout:
            if line.startswith("out_time_us="):
                try:
                    on_fraction(min(1.0, int(line.split("=")[1]) / 1e6 / total))
                except ValueError:
                    pass
        err = proc.stderr.read()
        code = proc.wait()
    else:
        r = subprocess.run(cmd, capture_output=True, text=True, creationflags=NO_WINDOW)
        err, code = r.stderr, r.returncode
    if code != 0:
        raise RuntimeError(f"FFmpeg failed:\n{err.strip()[-1500:]}")


# ---------- images & scenes ----------

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


def parse_scene_file(path):
    """Narration per scene, and chapter titles.

    Scene lines are "narration | image prompt" (or just narration). A line
    "## Title" starts a chapter at the next scene; other "#" lines are notes.
    Returns (lines, chapters) with chapters = {scene_index: title}.
    """
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    lines, chapters, pending = [], {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^##\s*(.+)$", line)
        if m:
            pending = m.group(1).strip()
            continue
        if line.startswith("#"):
            continue
        if pending:
            chapters[len(lines)] = pending
            pending = None
        lines.append(line.split("|", 1)[0].strip() if "|" in line else line)
    return lines, chapters


def read_script(path):
    return parse_scene_file(path)[0]


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
    chapters ({scene_index: title}), scenes (list of image lists, one per
    scene), missing (scene numbers with no image), extra (images with no scene).
    """
    images = pick_images(folder, first_per_prompt)
    path = find_script(folder, script)
    if not path:
        return {"script": None, "lines": None, "chapters": {}, "scenes": [[p] for p in images], "missing": [], "extra": []}
    lines, chapters = parse_scene_file(path)
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
    return {"script": path, "lines": lines, "chapters": chapters, "scenes": scenes, "missing": missing, "extra": extra}


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


def speech_import_help(err):
    """Explain why faster-whisper can't be loaded – with the real error and which Python ran."""
    detail = f"{type(err).__name__}: {err}"
    where = f"Python used: {sys.executable}"
    if isinstance(err, ModuleNotFoundError) and (err.name or "").split(".")[0] in ("faster_whisper", "ctranslate2", "av", "onnxruntime", "tokenizers"):
        return (
            "The speech library isn't installed for the Python that runs this tool.\n\n"
            "Fix: double-click Setup.bat again (it installs into this same Python).\n\n"
            f"{where}\n{detail}"
        )
    if "DLL" in str(err):
        return (
            "The speech library is installed but Windows can't load it – usually the "
            "Microsoft Visual C++ Redistributable is missing.\n\n"
            "Fix: double-click Setup.bat again (it installs that too), or run in a terminal:\n"
            "winget install Microsoft.VCRedist.2015+.x64\n\n"
            f"{where}\n{detail}"
        )
    return f"The speech library couldn't be loaded.\n\nFix: double-click Setup.bat again.\n\n{where}\n{detail}"


def transcribe_words(ffmpeg, audio, total, on_progress, on_status):
    """Return [(token, start, end)] in seconds for every spoken word."""
    # The model download's newer "xet" transfer can stall on some connections;
    # plain HTTP is resumable and reliable.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(speech_import_help(e))
    on_status("Loading the speech model (the first time it downloads ~480 MB)…")
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    on_status("Listening to the narration…")
    samples = load_audio_16k(ffmpeg, audio)
    segments, _info = model.transcribe(samples, word_timestamps=True, vad_filter=True)
    out = []
    for seg in segments:
        for w in seg.words or []:
            for tok in tokens(w.word):
                out.append((tok, w.start, w.end))
        on_progress(min(1.0, seg.end / total))
    return out


def align(lines, spoken):
    """Match the script's words to the spoken words (tolerant of small differences).

    Returns (s_line, start_of, end_of, matched_fraction): the scene index of every
    script token, and the spoken start/end time of each matched script token.
    """
    s_tok, s_line = [], []
    for i, line in enumerate(lines):
        for t in tokens(line):
            s_tok.append(t)
            s_line.append(i)
    sm = difflib.SequenceMatcher(None, s_tok, [t for t, _, _ in spoken], autojunk=False)
    start_of, end_of = {}, {}
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            start_of[a + k] = spoken[b + k][1]
            end_of[a + k] = spoken[b + k][2]
    return s_line, start_of, end_of, len(start_of) / max(1, len(s_tok))


def scene_starts(lines, aligned, total):
    """When each script line starts: the time of its first matched word."""
    s_line, start_of, _, _ = aligned
    starts = []
    for i in range(len(lines)):
        idx = [j for j, li in enumerate(s_line) if li == i]
        first = next((j for j in idx if j in start_of), None)
        if first is None:
            starts.append(None)
        else:
            # If the line's first words weren't recognised, step back ~0.35 s per word.
            starts.append(max(0.0, start_of[first] - 0.35 * (first - idx[0]) - LEAD_IN))

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
    return starts


# ---------- subtitles & chapters ----------

def word_timeline(lines, aligned, total):
    """Every script word (with its punctuation and spelling) with spoken start/end times.

    Words the speech model didn't catch get times interpolated from their neighbours.
    Returns [[scene_index, word, start, end], …].
    """
    _, start_of, end_of, _ = aligned
    timed, j = [], 0
    for i, line in enumerate(lines):
        for w in line.split():
            n = len(tokens(w))
            ks = range(j, j + n)
            st = min((start_of[k] for k in ks if k in start_of), default=None)
            en = max((end_of[k] for k in ks if k in end_of), default=None)
            timed.append([i, w, st, en])
            j += n
    known = [k for k, t in enumerate(timed) if t[2] is not None]
    if not known:
        return []
    for k, t in enumerate(timed):
        if t[2] is None:
            p = max((x for x in known if x < k), default=None)
            q = min((x for x in known if x > k), default=None)
            t0, i0 = (timed[p][3], p) if p is not None else (0.0, -1)
            t1, i1 = (timed[q][2], q) if q is not None else (total, len(timed))
            t[2] = t0 + (t1 - t0) * (k - i0) / (i1 - i0)
    for k, t in enumerate(timed):
        if k:
            t[2] = max(t[2], timed[k - 1][2])
        nxt = timed[k + 1][2] if k + 1 < len(timed) and timed[k + 1][2] is not None else total
        if t[3] is None or t[3] < t[2]:
            t[3] = max(t[2] + 0.2, min(nxt, t[2] + 0.6))
    return timed


def _balanced_parts(words):
    """Split one sentence's words into the fewest subtitle lines that fit, of even
    length, preferring breaks after commas – no lonely last word."""
    text_len = len(" ".join(w[1] for w in words))
    dur = words[-1][3] - words[0][2]
    parts_needed = max(1, -(-text_len // SUB_MAX_CHARS), int(dur // SUB_MAX_SECONDS) + (dur % SUB_MAX_SECONDS > 0.5))
    if parts_needed == 1:
        return [words]
    target = text_len / parts_needed
    parts, cur, cur_len = [], [], 0
    for k, w in enumerate(words):
        add = len(w[1]) + (1 if cur else 0)
        left = len(words) - k
        full = cur and cur_len + add > SUB_MAX_CHARS
        comma_break = cur and cur_len >= 0.6 * target and cur[-1][1].endswith((",", ";", ":"))
        even_break = cur and cur_len + add > target * 1.15 and len(parts) < parts_needed - 1
        if (full or comma_break or even_break) and left >= 2:
            parts.append(cur)
            cur, cur_len, add = [], 0, len(w[1])
        cur.append(w)
        cur_len += add
    if cur:
        parts.append(cur)
    return parts


def subtitle_cues(timed, total):
    """Subtitle lines: one sentence per cue when it fits (~42 characters / 5 s),
    longer sentences split into even parts. Never crosses into the next scene."""
    sentences, cur = [], []
    for item in timed:
        if cur and cur[-1][0] != item[0]:
            sentences.append(cur)
            cur = []
        cur.append(item)
        if re.search(r"[.!?…][\"'”’)\]]*$", item[1]):
            sentences.append(cur)
            cur = []
    if cur:
        sentences.append(cur)
    cues = []
    for sentence in sentences:
        for part in _balanced_parts(sentence):
            cues.append([part[0][2], part[-1][3], " ".join(w[1] for w in part)])
    for i, c in enumerate(cues):  # stay a little after the last word, never overlap the next line
        nxt = cues[i + 1][0] if i + 1 < len(cues) else total
        c[1] = min(max(c[1] + 0.3, c[0] + 0.7), nxt)
    return cues


def srt_time(t):
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def clock(t):
    t = int(t)
    h, rest = divmod(t, 3600)
    return f"{h}:{rest // 60:02d}:{rest % 60:02d}" if h else f"{rest // 60}:{rest % 60:02d}"


def short_title(line):
    first = re.split(r"(?<=[.!?])\s", line.strip(), maxsplit=1)[0].rstrip(".!?,;: ")
    words = first.split()
    return " ".join(words[:7]) + ("…" if len(words) > 7 else "")


def make_chapters(lines, chapters, starts, total):
    """[(seconds, title)] following YouTube's rules – first at 0:00, at least 3,
    each at least 10 s – or [] if the video is too short for chapters.

    Uses the "## Title" lines from the scene file; otherwise about one chapter
    per minute, titled from the narration.
    """
    if chapters:
        marks = sorted((starts[i], t) for i, t in chapters.items() if i < len(starts))
        if not marks or marks[0][0] > 0.5:
            marks.insert(0, (0.0, "Intro"))
    else:
        n = max(3, min(10, round(total / 60)))
        marks, target = [], 0.0
        for i, s in enumerate(starts):
            if s >= target - 1e-6:
                marks.append((s, short_title(lines[i])))
                target = len(marks) * total / n
    marks[0] = (0.0, marks[0][1])
    out = []
    for s, t in marks:
        if not out or s - out[-1][0] >= CHAPTER_MIN:
            out.append((s, t))
    while len(out) > 1 and total - out[-1][0] < CHAPTER_MIN:
        out.pop()
    return out if len(out) >= 3 else []


def write_youtube_text(path, title, chapters, total):
    lines = [
        "YouTube description – copy what you need below the line",
        "-" * 60,
        "",
        title,
        "",
    ]
    if chapters:
        lines += ["Chapters"] + [f"{clock(s)} {t}" for s, t in chapters]
    else:
        lines.append(f"(No chapters: YouTube needs at least 3 chapters of 10+ seconds; this video is {clock(total)} long.)")
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------- build ----------

def build_video(plan, audio, output, background, on_progress, on_status=lambda s: None,
                zoom=False, music=None, music_level="Quiet"):
    """Make the MP4 from plan_scenes().

    Returns (total_seconds, durations, note, extra_files).
    """
    ffmpeg, ffprobe = find_tool("ffmpeg"), find_tool("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("FFmpeg is not installed.\n\nInstall it once by running this in a terminal:\n\nwinget install Gyan.FFmpeg\n\nthen open this tool again.")

    total = audio_duration(ffprobe, audio)
    scenes, lines = plan["scenes"], plan["lines"]
    note, extra_files = "", []
    # Progress bar: listening (if any) → preparing images → video → final mix.
    if lines:
        p_listen, p_img, p_video = 0.45, 0.07, 0.40
        spoken = transcribe_words(ffmpeg, audio, total, lambda f: on_progress(p_listen * f), on_status)
        aligned = align(lines, spoken)
        starts = scene_starts(lines, aligned, total)
        matched = aligned[3]
        note = f"{matched:.0%} of the script's words were found in the narration."
        if matched < 0.5:
            note += " That is low – check that the script matches this audio."
    else:
        p_listen, p_img, p_video = 0.0, 0.15, 0.75
        lines = [""] * len(scenes)
        starts = [total * i / len(scenes) for i in range(len(scenes))]
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
    durations = [d for _, _, d in shots]

    # Timing sheet next to the video, to check or share.
    chapter_at = plan.get("chapters") or {}
    with open(output.with_name(output.stem + "_timings.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["scene", "image", "starts_at", "seconds", "chapter", "narration"])
        for i, (imgs, s, d, line) in enumerate(zip(scenes, starts, scene_len, lines), 1):
            name = " + ".join(p.name for p in imgs) or "(no image - previous one stays)"
            w.writerow([i, name, f"{int(s // 60)}:{s % 60:05.2f}", f"{d:.2f}", chapter_at.get(i - 1, ""), line])

    # Subtitles and YouTube description (need the narration text).
    if plan["lines"]:
        cues = subtitle_cues(word_timeline(lines, aligned, total), total)
        srt = output.with_suffix(".srt")
        srt.write_text(
            "\n".join(f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n" for n, (a, b, text) in enumerate(cues, 1)),
            encoding="utf-8",
        )
        yt = output.with_name(output.stem + "_youtube.txt")
        write_youtube_text(yt, output.stem.replace("_", " "), make_chapters(lines, chapter_at, starts, total), total)
        extra_files += [srt.name, yt.name]

    with tempfile.TemporaryDirectory(prefix="flowbatch_") as tmp:
        tmp = Path(tmp)

        # 1. Bring every image to exactly 1920x1080 with borders. Joining images of
        #    different sizes directly makes FFmpeg drop frames, so they must match first.
        on_status(f"Preparing {len(shots)} images…")
        fit = (
            f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:color={background},setsar=1"
        )
        frames = []
        for i, (img, _, _) in enumerate(shots):
            frame = tmp / f"{i:05d}.png"
            r = subprocess.run(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(img), "-vf", fit, "-frames:v", "1", str(frame)],
                capture_output=True, text=True, creationflags=NO_WINDOW,
            )
            if r.returncode != 0:
                raise RuntimeError(f"Could not read image {img.name}:\n{r.stderr.strip()[-800:]}")
            frames.append(frame)
            on_progress(p_listen + p_img * (i + 1) / len(shots))

        # 2. The picture track (no sound yet).
        base = p_listen + p_img
        video_only = tmp / "video.mp4"
        if zoom:
            # Slow zoom: one short clip per image (alternating in/out), frame counts
            # taken from the running total so the cuts stay exactly on time.
            on_status("Making the video (slow zoom)…")
            clips, done = [], 0
            for i, ((_, s, d), frame) in enumerate(zip(shots, frames)):
                n = max(1, round((s + d) * FPS) - done)
                done += n
                z = f"1+{ZOOM}*on/{n}" if i % 2 == 0 else f"{1 + ZOOM}-{ZOOM}*on/{n}"
                clip = tmp / f"clip{i:05d}.mp4"
                run_ffmpeg([
                    ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(frame),
                    "-vf", (f"scale={WIDTH * 2}:{HEIGHT * 2},zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                            f":d={n}:s={WIDTH}x{HEIGHT}:fps={FPS},format=yuv420p"),
                    "-frames:v", str(n), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", str(clip),
                ])
                clips.append(clip)
                on_progress(base + p_video * (i + 1) / len(shots))
            clip_list = tmp / "clips.txt"
            clip_list.write_text("\n".join(f"file '{c.as_posix()}'" for c in clips), encoding="utf-8")
            run_ffmpeg([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(clip_list), "-c", "copy", str(video_only)])
        else:
            on_status("Making the video…")
            # ffmpeg "concat" list – each frame with its duration (last one repeated, as ffmpeg requires).
            entries = []
            for frame, d in zip(frames, durations):
                entries += [f"file '{frame.as_posix()}'", f"duration {d:.4f}"]
            entries.append(f"file '{frames[-1].as_posix()}'")
            list_file = tmp / "list.txt"
            list_file.write_text("\n".join(entries), encoding="utf-8")
            run_ffmpeg([
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(list_file),
                "-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-tune", "stillimage", "-an", "-t", f"{total:.3f}", str(video_only),
            ], total, lambda f: on_progress(base + p_video * f))

        # 3. Add the sound: narration, plus optional music that dips while the narrator speaks.
        on_status("Adding the sound…")
        cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(video_only), "-i", str(audio)]
        if music:
            level = MUSIC_LEVELS.get(music_level, MUSIC_LEVELS["Quiet"])
            fade = max(0.0, total - 3)
            # A mono voice is copied to both sides at full volume (FFmpeg's default
            # mono→stereo conversion would make it 3 dB quieter).
            voice_fmt = "pan=stereo|c0=c0|c1=c0," if audio_channels(ffprobe, audio) == 1 else ""
            fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
            graph = (
                f"[1:a]{voice_fmt}{fmt},asplit=2[voice][key];"
                f"[2:a]{fmt},volume={level},afade=t=out:st={fade:.2f}:d=3[bed];"
                f"[bed][key]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=600[ducked];"
                f"[voice][ducked]amix=inputs=2:duration=first:normalize=0[mix]"
            )
            cmd += ["-stream_loop", "-1", "-i", str(music), "-filter_complex", graph, "-map", "0:v", "-map", "[mix]"]
        else:
            cmd += ["-map", "0:v", "-map", "1:a"]
        cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(output)]
        run_ffmpeg(cmd, total, lambda f: on_progress(base + p_video + (1 - base - p_video) * f))
    return total, durations, note, extra_files


# ---------- window ----------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Flow Batch – Make Video")
        self.resizable(False, False)
        self.folder = tk.StringVar()
        self.audio = tk.StringVar()
        self.script = tk.StringVar()
        self.music = tk.StringVar()
        self.music_level = tk.StringVar(value="Quiet")
        self.first_only = tk.BooleanVar(value=True)
        self.zoom = tk.BooleanVar(value=False)
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

        ttk.Label(frm, text="Background music").grid(row=4, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.music, width=55).grid(row=4, column=1, **pad)
        mbox = ttk.Frame(frm)
        mbox.grid(row=4, column=2, **pad)
        ttk.Button(mbox, text="Browse…", command=self.pick_music).pack(side="left")
        ttk.Button(mbox, text="✕", width=2, command=lambda: self.music.set("")).pack(side="left", padx=(4, 0))
        mrow = ttk.Frame(frm)
        mrow.grid(row=5, column=1, columnspan=2, sticky="w", padx=10)
        ttk.Label(mrow, text="Optional, loops and fades out; quieter while the narrator speaks.  Volume:",
                  foreground="#666").pack(side="left")
        ttk.Combobox(mrow, textvariable=self.music_level, values=list(MUSIC_LEVELS), width=7,
                     state="readonly").pack(side="left", padx=(4, 0))

        opts = ttk.Frame(frm)
        opts.grid(row=6, column=0, columnspan=3, sticky="w", **pad)
        ttk.Checkbutton(opts, text="Only the first image of each prompt (001_…_1)", variable=self.first_only,
                        command=self.refresh_count).pack(side="left")
        ttk.Checkbutton(opts, text="Slow zoom on images", variable=self.zoom).pack(side="left", padx=(12, 0))
        ttk.Label(opts, text="   Border:").pack(side="left")
        ttk.Combobox(opts, textvariable=self.bg, values=["white", "black"], width=7, state="readonly").pack(side="left")

        self.count = ttk.Label(frm, text="")
        self.count.grid(row=7, column=0, columnspan=3, sticky="w", **pad)

        self.bar = ttk.Progressbar(frm, length=560, maximum=1.0)
        self.bar.grid(row=8, column=0, columnspan=3, **pad)
        ttk.Label(frm, textvariable=self.status, wraplength=560).grid(row=9, column=0, columnspan=3, sticky="w", **pad)

        self.go = ttk.Button(frm, text="Make video", command=self.start)
        self.go.grid(row=10, column=0, columnspan=3, pady=(6, 2))

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

    def pick_music(self):
        f = filedialog.askopenfilename(title="Background music", filetypes=AUDIO_TYPES)
        if f:
            self.music.set(f)

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
        if plan["chapters"]:
            text += f" {len(plan['chapters'])} chapter title(s)."
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
        music = self.music.get().strip()
        if not folder or not Path(folder).is_dir():
            return messagebox.showwarning("Make Video", "Pick the images folder first.")
        if not audio or not Path(audio).is_file():
            return messagebox.showwarning("Make Video", "Pick the narration audio first.")
        if script and not Path(script).is_file():
            return messagebox.showwarning("Make Video", "The script file wasn't found.")
        if music and not Path(music).is_file():
            return messagebox.showwarning("Make Video", "The music file wasn't found.")
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
        n_images = sum(len(s) for s in plan["scenes"])

        self.go.config(state="disabled")
        self.bar["value"] = 0

        def progress(frac):
            self.after(0, lambda: self.bar.configure(value=frac))

        def status(text):
            self.after(0, lambda: self.status.set(text))

        def work():
            try:
                total, durations, note, extra = build_video(
                    plan, audio, output, self.bg.get(), progress, status,
                    zoom=self.zoom.get(), music=music or None, music_level=self.music_level.get(),
                )
                mode = "matched to the narration" if plan["script"] else "equal timing"
                files = [f"{output.stem}_timings.csv"] + extra
                msg = (f"Done! {output}\n{n_images} images, {total:.0f} s, {mode} "
                       f"(shortest {min(durations):.1f} s, longest {max(durations):.1f} s). {note}\n"
                       f"Also saved: {', '.join(files)}")
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
