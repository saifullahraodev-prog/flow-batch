"""Flow Batch – Make Video.

Turns a folder of images + one narration file into a 1920x1080 MP4 for YouTube.

* With a script (scenes.txt from Flow Batch, or any .txt with one line of
  narration per image): the narration is transcribed on this PC (Whisper) and
  every image appears exactly when its line starts being spoken. Subtitles
  (.srt) and a YouTube description with chapters are written too.
* Without a script: each image gets an equal share of the audio.
* Options: slow zoom on every image, quiet background music that dips while
  the narrator speaks, subtitles burned into the picture.

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
PAN = 0.10                # pans: the picture is enlarged 10 % and slides across
FADE = 0.4                # crossfade between pictures, seconds
ROCK_DEGREES, ROCK_SECONDS = 0.8, 5.0   # [rock]: gentle tilt, like a ship at sea
# Motion per scene, from a tag in the scene's prompt: "… storm at sea [rock] [rain]".
MOTION_TAGS = ("zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "rock", "shake", "still")
WEATHER_TAGS = ("rain", "snow")
TAG_RE = re.compile(r"\[(" + "|".join(MOTION_TAGS + WEATHER_TAGS) + r")\]", re.I)
AUTO_MOTIONS = ("zoom-in", "pan-right", "zoom-out", "pan-left", "zoom-in", "pan-up", "zoom-out", "pan-down")
MOTION_MODES = {"Auto – zoom & pan": "auto", "Zoom only": "zoom", "Off – still pictures": "off"}
MUSIC_LEVELS = {"Quiet": 0.10, "Medium": 0.18, "Loud": 0.28}
MISSING_BELOW = 0.3       # a scene with fewer of its words heard counts as "not in the audio"
SUB_MAX_CHARS = 42        # one subtitle line
SUB_MAX_SECONDS = 5.0
# Burned-in subtitles: small white text, thin black outline, near the bottom.
# (Sizes are on libass's 288-line canvas, scaled up to 1080: 12 ≈ 45 px.)
SUB_STYLE = ("FontName=Arial,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
             "BorderStyle=1,Outline=1,Shadow=0,MarginV=14")
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


def run_ffmpeg(cmd, total=None, on_fraction=None, cwd=None):
    """Run FFmpeg; report progress (0–1) from its -progress output when total is given."""
    if total and on_fraction:
        cmd = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd,
                                creationflags=NO_WINDOW)
        for line in proc.stdout:
            if line.startswith("out_time_us="):
                try:
                    on_fraction(min(1.0, int(line.split("=")[1]) / 1e6 / total))
                except ValueError:
                    pass
        err = proc.stderr.read()
        code = proc.wait()
    else:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, creationflags=NO_WINDOW)
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

    Scene lines are "narration | image prompt" (or just narration). Or the
    prompt file's own format: a "(narration)" line in brackets, with the image
    prompt on the line below it. A line "## Title" starts a chapter at the next
    scene; other "#" lines are notes. Tags like [rain] or [rock] anywhere in a
    scene choose its motion / weather effect (see MOTION_TAGS, WEATHER_TAGS).
    Returns (lines, chapters, tags): chapters = {scene_index: title},
    tags = one set per scene.
    """
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    rows = [r.strip() for r in text.splitlines()]
    bracketed = any(re.match(r"^\(.*\)$", r) for r in rows)
    lines, chapters, tags, pending, said, found = [], {}, [], None, [], set()

    def add(narration):
        nonlocal pending, found
        if pending:
            chapters[len(lines)] = pending
            pending = None
        lines.append(narration)
        tags.append(found)
        found = set()

    for line in rows:
        if not line:
            continue
        m = re.match(r"^##\s*(.+)$", line)
        if m:
            pending = m.group(1).strip()
            continue
        if line.startswith("#"):
            continue
        found |= {t.lower() for t in TAG_RE.findall(line)}
        line = " ".join(TAG_RE.sub(" ", line).split())
        if not line:  # a line with only tags: they belong to the next scene
            continue
        if bracketed:
            n = re.match(r"^\((.*)\)$", line)
            if n:
                said.append(n.group(1).strip())
            else:  # the image prompt: one scene, narrated by the bracket line(s) above it
                add(" ".join(said) if said else (line.split("|", 1)[0].strip() if "|" in line else ""))
                said = []
            continue
        add(line.split("|", 1)[0].strip() if "|" in line else line)
    if said:
        add(" ".join(said))
    return lines, chapters, tags


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
        return {"script": None, "lines": None, "chapters": {}, "tags": [set() for _ in images],
                "scenes": [[p] for p in images], "missing": [], "extra": []}
    lines, chapters, tags = parse_scene_file(path)
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
    return {"script": path, "lines": lines, "chapters": chapters, "tags": tags, "scenes": scenes,
            "missing": missing, "extra": extra}


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


def narration_missing(lines, aligned):
    """Scenes whose narration is not in the audio (not recorded, or cut out):
    none – or hardly any – of their words were heard."""
    s_line, start_of, _, _ = aligned
    count, found = [0] * len(lines), [0] * len(lines)
    for j, li in enumerate(s_line):
        count[li] += 1
        found[li] += j in start_of
    return [i for i in range(len(lines))
            if count[i] and (found[i] == 0 or (count[i] >= 4 and found[i] / count[i] < MISSING_BELOW))]


def scene_starts(lines, aligned, total, skip=()):
    """When each script line starts: the time of its first matched word.

    Scenes in skip (narration not in the audio) get no time: their start is the
    next scene's start.
    """
    s_line, start_of, _, _ = aligned
    keep = [i for i in range(len(lines)) if i not in skip]
    starts = {}
    for i in keep:
        idx = [j for j, li in enumerate(s_line) if li == i]
        first = next((j for j in idx if j in start_of), None)
        # If the line's first words weren't recognised, step back ~0.35 s per word.
        starts[i] = None if first is None else max(0.0, start_of[first] - 0.35 * (first - idx[0]) - LEAD_IN)

    # Lines with no recognised words: place them evenly between their neighbours.
    known = [(i, s) for i, s in starts.items() if s is not None]
    if not known:
        raise RuntimeError("None of the script's words were found in the narration – is it the right script for this audio?")
    for i in keep:
        if starts[i] is None:
            prev = max(((j, t) for j, t in known if j < i), default=(-1, 0.0))
            nxt = min(((j, t) for j, t in known if j > i), default=(len(lines), total))
            starts[i] = prev[1] + (nxt[1] - prev[1]) * (i - prev[0]) / (nxt[0] - prev[0])

    # First image from the very start; keep order and a minimum length per image.
    seq = [starts[i] for i in keep]
    seq[0] = 0.0
    for k in range(1, len(seq)):
        seq[k] = max(seq[k], seq[k - 1] + MIN_SCENE)
    for k in range(len(seq) - 1, 0, -1):  # don't run past the end of the audio
        seq[k] = min(seq[k], total - MIN_SCENE * (len(seq) - k))
    out, nxt = [None] * len(lines), total
    for i, t in zip(keep, seq):
        out[i] = t
    for i in range(len(lines) - 1, -1, -1):
        if out[i] is None:
            out[i] = nxt
        nxt = out[i]
    return out


# ---------- subtitles & chapters ----------

def word_timeline(lines, aligned, total, skip=()):
    """Every script word (with its punctuation and spelling) with spoken start/end times.

    Words the speech model didn't catch get times interpolated from their neighbours.
    Scenes in skip (not in the audio) are left out. Returns [[scene_index, word, start, end], …].
    """
    _, start_of, end_of, _ = aligned
    timed, j = [], 0
    for i, line in enumerate(lines):
        for w in line.split():
            n = len(tokens(w))
            ks = range(j, j + n)
            st = min((start_of[k] for k in ks if k in start_of), default=None)
            en = max((end_of[k] for k in ks if k in end_of), default=None)
            if i not in skip:
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


def make_chapters(lines, chapters, starts, total, skip=()):
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
            if i not in skip and s >= target - 1e-6:
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


# ---------- motion ----------

def pick_motion(mode, tags, i):
    """The motion of shot i: its tag if it has one, else from the Motion setting."""
    tagged = next((t for t in MOTION_TAGS if t in tags), None)
    if tagged:
        return tagged
    if mode == "auto":
        return AUTO_MOTIONS[i % len(AUTO_MOTIONS)]
    if mode == "zoom":
        return "zoom-in" if i % 2 == 0 else "zoom-out"
    return "still"


def motion_filter(motion, n):
    """FFmpeg filter that moves one 1920x1080 picture over n frames.

    Returns (filter, looped): zoom/pan use zoompan on a single input frame (no
    loop); rock/shake/still need the picture as a looped input.
    """
    if motion in ("zoom-in", "zoom-out") or motion.startswith("pan-"):
        p = f"on/{max(1, n - 1)}"  # 0 → 1 over the shot
        mid_x, mid_y = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
        z, x, y = f"{1 + PAN}", mid_x, mid_y
        if motion == "zoom-in":
            z = f"1+{ZOOM}*{p}"
        elif motion == "zoom-out":
            z = f"{1 + ZOOM}-{ZOOM}*{p}"
        elif motion == "pan-right":
            x = f"(iw-iw/zoom)*{p}"
        elif motion == "pan-left":
            x = f"(iw-iw/zoom)*(1-{p})"
        elif motion == "pan-down":
            y = f"(ih-ih/zoom)*{p}"
        elif motion == "pan-up":
            y = f"(ih-ih/zoom)*(1-{p})"
        # Enlarged first so the slow movement stays smooth (no 1-pixel steps).
        return (f"scale={WIDTH * 2}:{HEIGHT * 2},zoompan=z='{z}':x='{x}':y='{y}'"
                f":d={n}:s={WIDTH}x{HEIGHT}:fps={FPS}", False)
    if motion == "rock":
        # Slight tilt back and forth plus a small rise and fall, picture enlarged 8 %.
        w, h = round(WIDTH * 1.08 / 2) * 2, round(HEIGHT * 1.08 / 2) * 2
        a = f"{ROCK_DEGREES}*PI/180*sin(2*PI*t/{ROCK_SECONDS})"
        return (f"scale={w}:{h},rotate=a='{a}':ow={WIDTH}:oh={HEIGHT + 24},"
                f"crop={WIDTH}:{HEIGHT}:0:'12+10*sin(2*PI*t/{ROCK_SECONDS}+1.2)'", True)
    if motion == "shake":
        # Uneven camera shake (storms, explosions), picture enlarged 5 %.
        w, h = round(WIDTH * 1.05 / 2) * 2, round(HEIGHT * 1.05 / 2) * 2
        mx, my = (w - WIDTH) // 2, (h - HEIGHT) // 2
        return (f"scale={w}:{h},crop={WIDTH}:{HEIGHT}:'{mx}+{mx * 0.6:.0f}*sin(t*21)+{mx * 0.3:.0f}*sin(t*47)'"
                f":'{my}+{my * 0.6:.0f}*sin(t*27)+{my * 0.3:.0f}*sin(t*59)'", True)
    return ("null", True)


def make_weather_layer(ffmpeg, kind, path):
    """A see-through layer of rain streaks or snowflakes, two identical 1080-line
    halves stacked so it can scroll down endlessly. Written as PNG with alpha."""
    import numpy as np

    rng = np.random.default_rng(7 if kind == "rain" else 11)
    w, h = WIDTH + 80, HEIGHT
    rgba = np.zeros((h, w, 4), np.uint8)
    if kind == "rain":
        for _ in range(900):
            x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
            length = rng.uniform(28, 60)
            k = np.linspace(0, 1, int(length))
            xs = ((x0 + 0.18 * length * k) % w).astype(int)
            ys = ((y0 + length * k) % h).astype(int)
            alpha = int(rng.uniform(110, 190))
            for dx in (0, 1):  # 2 px wide, grey-blue: visible on light and dark pictures
                xx = (xs + dx) % w
                rgba[ys, xx, :3] = (178, 192, 212)
                rgba[ys, xx, 3] = np.maximum(rgba[ys, xx, 3], alpha)
    else:
        yy, xx = np.mgrid[-4:5, -4:5]
        for _ in range(650):
            cx, cy, r = rng.uniform(0, w), rng.uniform(0, h), rng.uniform(1.4, 3.6)
            soft = np.clip(1.4 - np.hypot(xx, yy) / r, 0, 1)
            xs = ((cx + xx) % w).astype(int)
            ys = ((cy + yy) % h).astype(int)
            a = (soft * rng.uniform(150, 230)).astype(np.uint8)
            rgba[ys, xs, :3] = 255
            rgba[ys, xs, 3] = np.maximum(rgba[ys, xs, 3], a)
    layer = np.vstack([rgba, rgba])
    r = subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
         "-s", f"{w}x{2 * h}", "-i", "-", "-frames:v", "1", str(path)],
        input=layer.tobytes(), capture_output=True, creationflags=NO_WINDOW,
    )
    if r.returncode != 0:
        raise RuntimeError(f"Could not make the {kind} layer:\n{r.stderr.decode(errors='replace')[-600:]}")


def render_clip(ffmpeg, frame, n, motion, weather, prev_last, out):
    """One shot: the moving picture, optional rain/snow on top, optional
    crossfade from the previous picture's last frame. Exactly n frames."""
    vf, looped = motion_filter(motion, n)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    cmd += (["-loop", "1", "-framerate", str(FPS)] if looped else []) + ["-i", str(frame)]
    if weather and weather[0] == "rain":
        vf += ",eq=brightness=-0.06:saturation=0.85"  # a little darker: rainy mood
    graph = f"[0:v]{vf},setsar=1,format=yuva420p[m]"
    k = 1
    if weather:
        cmd += ["-loop", "1", "-framerate", str(FPS), "-i", str(weather[1])]
        speed = 1500 if weather[0] == "rain" else 70
        sway = "-40" if weather[0] == "rain" else "-40+36*sin(t*0.7)"
        graph += f";[m][{k}:v]overlay=x='{sway}':y='-{HEIGHT}+mod(t*{speed},{HEIGHT})'[m]"
        k += 1
    if prev_last:
        fade = min(FADE, 0.5 * n / FPS)
        cmd += ["-loop", "1", "-framerate", str(FPS), "-i", str(prev_last)]
        graph += f";[m]fade=t=in:st=0:d={fade:.3f}:alpha=1[m];[{k}:v][m]overlay=0:0[m]"
    graph += ";[m]format=yuv420p[v]"
    cmd += ["-filter_complex", graph, "-map", "[v]", "-frames:v", str(n), "-r", str(FPS),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", str(out)]
    run_ffmpeg(cmd)


def last_frame(ffmpeg, clip, out):
    run_ffmpeg([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.5", "-i", str(clip),
                "-update", "1", "-q:v", "1", str(out)])


# ---------- build ----------

def build_video(plan, audio, output, background, on_progress, on_status=lambda s: None,
                zoom=False, music=None, music_level="Quiet", burn_subs=False, confirm=lambda msg, scenes: True,
                motion="off", crossfade=False):
    """Make the MP4 from plan_scenes().

    motion: "auto" (zoom and pan, varied), "zoom" (slow zoom in/out) or "off";
    tags in the scene file ([rock], [rain] …) override it per scene.
    crossfade: blend each picture into the next (FADE seconds).

    confirm(message, [(scene_number, narration), …]) -> bool is asked when some
    scenes' narration is not in the audio; False stops without making a video.
    Returns (total_seconds, durations, note, extra_files).
    """
    if zoom and motion == "off":
        motion = "zoom"
    ffmpeg, ffprobe = find_tool("ffmpeg"), find_tool("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("FFmpeg is not installed.\n\nInstall it once by running this in a terminal:\n\nwinget install Gyan.FFmpeg\n\nthen open this tool again.")

    total = audio_duration(ffprobe, audio)
    scenes, lines = plan["scenes"], plan["lines"]
    note, extra_files, skip = "", [], set()
    # Progress bar: listening (if any) → preparing images → video → final mix.
    if lines:
        p_listen, p_img, p_video = 0.45, 0.07, 0.40
        spoken = transcribe_words(ffmpeg, audio, total, lambda f: on_progress(p_listen * f), on_status)
        aligned = align(lines, spoken)
        skip = set(narration_missing(lines, aligned))
        if len(skip) == len(lines):
            skip = set()  # nothing matches at all: wrong script or audio – scene_starts reports it
        if skip:
            cut = lambda t: t if len(t) <= 90 else t[:87].rstrip() + "…"
            listed = "\n".join(f"  Scene {i + 1}: \"{cut(lines[i])}\"" for i in sorted(skip)[:12])
            more = f"\n  … and {len(skip) - 12} more" if len(skip) > 12 else ""
            if not confirm(
                f"This narration is not in the audio (not recorded, or cut out):\n\n{listed}{more}\n\n"
                "Make the video anyway? Those scenes are left out – their images are not shown.\n\n"
                "Or click No, record the missing narration, and try again.",
                [(i + 1, lines[i]) for i in sorted(skip)],
            ):
                raise RuntimeError("Stopped – narration not in the audio for scene(s) "
                                   + ", ".join(str(i + 1) for i in sorted(skip)) + ". Nothing was made.")
        starts = scene_starts(lines, aligned, total, skip)
        matched = aligned[3]
        note = f"{matched:.0%} of the script's words were found in the narration."
        if matched < 0.5:
            note += " That is low – check that the script matches this audio."
        if skip:
            note += (" Narration not in the audio – left out: scene(s) "
                     + ", ".join(str(i + 1) for i in sorted(skip)) + ".")
    else:
        p_listen, p_img, p_video = 0.0, 0.15, 0.75
        lines = [""] * len(scenes)
        starts = [total * i / len(scenes) for i in range(len(scenes))]
    scene_len = [b - a for a, b in zip(starts, starts[1:] + [total])]

    # Turn scenes into shots (image, start, seconds, tags). A scene without an image
    # keeps the previous image on screen; several images in one scene share its time.
    scene_tags = plan.get("tags") or [set() for _ in scenes]
    shots, carry = [], 0.0
    for imgs, s, d, tags in zip(scenes, starts, scene_len, scene_tags):
        if d <= 1e-6:  # narration not in the audio: the scene is left out
            continue
        if not imgs:
            if shots:
                img, s0, d0, t0 = shots[-1]
                shots[-1] = (img, s0, d0 + d, t0)
            else:
                carry += d  # missing first scene(s): the first image starts at 0
            continue
        s, d = s - carry, d + carry
        carry = 0.0
        for k, img in enumerate(imgs):
            shots.append((img, s + d * k / len(imgs), d / len(imgs), tags))
    durations = [d for _, _, d, _ in shots]

    # Timing sheet next to the video, to check or share.
    chapter_at = plan.get("chapters") or {}
    with open(output.with_name(output.stem + "_timings.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["scene", "image", "starts_at", "seconds", "chapter", "narration", "narration_in_audio"])
        for i, (imgs, s, d, line) in enumerate(zip(scenes, starts, scene_len, lines), 1):
            name = " + ".join(p.name for p in imgs) or "(no image - previous one stays)"
            heard = "" if not plan["lines"] else "NO - scene left out" if i - 1 in skip else "yes"
            w.writerow([i, name, f"{int(s // 60)}:{s % 60:05.2f}", f"{d:.2f}", chapter_at.get(i - 1, ""), line, heard])

    # Subtitles and YouTube description (need the narration text).
    if plan["lines"]:
        cues = subtitle_cues(word_timeline(lines, aligned, total, skip), total)
        srt = output.with_suffix(".srt")
        srt.write_text(
            "\n".join(f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n" for n, (a, b, text) in enumerate(cues, 1)),
            encoding="utf-8",
        )
        yt = output.with_name(output.stem + "_youtube.txt")
        write_youtube_text(yt, output.stem.replace("_", " "), make_chapters(lines, chapter_at, starts, total, skip), total)
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
        for i, (img, _, _, _) in enumerate(shots):
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
        if motion != "off" or crossfade or any(tags for _, _, _, tags in shots):
            # Motion: one short clip per image, frame counts taken from the running
            # total so the cuts stay exactly on time; then the clips are joined.
            on_status("Making the video (motion)…")
            clips, done, layers, prev_last = [], 0, {}, None
            for i, ((_, s, d, tags), frame) in enumerate(zip(shots, frames)):
                n = max(1, round((s + d) * FPS) - done)
                done += n
                kind = next((t for t in WEATHER_TAGS if t in tags), None)
                if kind and kind not in layers:
                    layers[kind] = tmp / f"{kind}.png"
                    make_weather_layer(ffmpeg, kind, layers[kind])
                clip = tmp / f"clip{i:05d}.mp4"
                render_clip(ffmpeg, frame, n, pick_motion(motion, tags, i), (kind, layers[kind]) if kind else None,
                            prev_last if crossfade else None, clip)
                if crossfade:
                    prev_last = tmp / f"last{i:05d}.png"
                    last_frame(ffmpeg, clip, prev_last)
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
        if burn_subs and plan["lines"]:
            # Draw the subtitles into the picture (re-encodes the video). The .srt is
            # copied into the temp folder and read by a plain relative name, because
            # Windows paths (C:\…) break FFmpeg's filter syntax.
            shutil.copy(srt, tmp / "subs.srt")
            cmd += ["-vf", f"subtitles=subs.srt:force_style='{SUB_STYLE}'",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
        else:
            cmd += ["-c:v", "copy"]
        cmd += ["-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(output)]
        if burn_subs and plan["lines"]:
            on_status("Adding the sound and subtitles…")
        run_ffmpeg(cmd, total, lambda f: on_progress(base + p_video + (1 - base - p_video) * f), cwd=tmp)
    return total, durations, note, extra_files


# ---------- window ----------

# Colours and fonts of the window.
C_BG, C_CARD, C_LINE = "#F3F5FA", "#FFFFFF", "#E3E7EF"
C_INK, C_MUTED = "#1F2937", "#6B7280"
C_HEAD, C_HEAD_SUB = "#14213D", "#9FB0CF"
C_ACCENT, C_ACCENT_DOWN = "#2563EB", "#1D4ED8"
C_OK, C_BAD, C_WARN = "#15803D", "#B91C1C", "#B45309"
FONT = "Segoe UI"


def cut(text, n=80):
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Flow Batch – Make Video")
        self.configure(bg=C_BG)
        self.resizable(False, False)
        self.folder = tk.StringVar()
        self.audio = tk.StringVar()
        self.script = tk.StringVar()
        self.music = tk.StringVar()
        self.music_level = tk.StringVar(value="Quiet")
        self.first_only = tk.BooleanVar(value=True)
        self.motion = tk.StringVar(value=next(iter(MOTION_MODES)))
        self.crossfade = tk.BooleanVar(value=True)
        self.subs = tk.BooleanVar(value=False)
        self.bg = tk.StringVar(value="white")
        self.status = tk.StringVar(value="Pick the images folder and the narration audio.")
        self.output = None
        self._styles()

        # Header
        head = tk.Frame(self, bg=C_HEAD, padx=22, pady=10)
        head.pack(fill="x")
        tk.Label(head, text="🎬  Make Video", bg=C_HEAD, fg="white", font=(FONT, 17, "bold")).pack(anchor="w")
        tk.Label(head, text="Images + narration  →  a YouTube-ready video, every picture on its line",
                 bg=C_HEAD, fg=C_HEAD_SUB, font=(FONT, 10)).pack(anchor="w")

        body = tk.Frame(self, bg=C_BG, padx=18, pady=12)
        body.pack(fill="both")

        # 1. Files
        files = self._card(body, "1", "Your files")
        self._file_row(files, 0, "Images folder", "The run folder from Flow Batch", self.folder, self.pick_folder)
        self._file_row(files, 1, "Narration audio", "One audio file: mp3, wav, m4a …", self.audio, self.pick_audio)
        self._file_row(files, 2, "Script  (optional)", "Not needed when the folder has scenes.txt",
                       self.script, self.pick_script, clear=True)

        # 2. Options
        opts = self._card(body, "2", "Options")
        checks = ttk.Frame(opts, style="Card.TFrame")
        checks.grid(row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(checks, text="Motion", style="Card.TLabel").pack(side="left")
        ttk.Combobox(checks, textvariable=self.motion, values=list(MOTION_MODES), width=20,
                     state="readonly").pack(side="left", padx=(8, 0))
        ttk.Checkbutton(checks, text="Crossfade", variable=self.crossfade).pack(side="left", padx=(18, 0))
        ttk.Checkbutton(checks, text="Subtitles on the video", variable=self.subs).pack(side="left", padx=(18, 0))
        border = ttk.Frame(opts, style="Card.TFrame")
        border.grid(row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Checkbutton(border, text="Only the first image of each prompt", variable=self.first_only,
                        command=self.refresh_check).pack(side="left")
        ttk.Label(border, text="Border around non-16:9 images", style="Card.TLabel").pack(side="left", padx=(18, 0))
        ttk.Combobox(border, textvariable=self.bg, values=["white", "black"], width=7,
                     state="readonly").pack(side="left", padx=(8, 0))
        ttk.Label(opts, text="Per scene, add a tag to its prompt: [rock] [shake] [rain] [snow] [still] "
                             "[zoom-in] [zoom-out] [pan-left] [pan-right] [pan-up] [pan-down]",
                  style="Muted.TLabel").grid(row=4, column=0, columnspan=3, sticky="w", pady=(8, 0))
        self._file_row(opts, 2, "Background music", "Optional – quieter while you speak",
                       self.music, self.pick_music, clear=True, top=6)
        vol = ttk.Frame(opts, style="Card.TFrame")
        vol.grid(row=3, column=1, sticky="w", pady=(2, 0))
        ttk.Label(vol, text="Music volume", style="Muted.TLabel").pack(side="left")
        ttk.Combobox(vol, textvariable=self.music_level, values=list(MUSIC_LEVELS), width=8,
                     state="readonly").pack(side="left", padx=(8, 0))

        # 3. Check
        check = self._card(body, "3", "Check")
        check.columnconfigure(0, weight=1, minsize=0)
        check.columnconfigure(1, weight=0)
        check.columnconfigure(2, minsize=0)
        self.report = tk.Text(check, height=6, width=70, wrap="word", relief="flat", bg="#F8FAFD",
                              fg=C_INK, font=(FONT, 10), padx=10, pady=8, cursor="arrow",
                              highlightthickness=1, highlightbackground=C_LINE)
        self.report.grid(row=0, column=0, sticky="we")
        scroll = ttk.Scrollbar(check, orient="vertical", command=self.report.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.report.configure(yscrollcommand=scroll.set)
        for tag, colour in (("ok", C_OK), ("bad", C_BAD), ("warn", C_WARN), ("muted", C_MUTED), ("ink", C_INK)):
            self.report.tag_configure(tag, foreground=colour)
        self.report.tag_configure("head", font=(FONT, 10, "bold"))
        self.report.tag_configure("quote", foreground=C_MUTED, lmargin1=26, lmargin2=26)

        # Progress + buttons
        foot = tk.Frame(body, bg=C_BG)
        foot.pack(fill="x", pady=(4, 0))
        self.bar = ttk.Progressbar(foot, maximum=1.0, style="Accent.Horizontal.TProgressbar")
        self.bar.pack(fill="x")
        tk.Label(foot, textvariable=self.status, bg=C_BG, fg=C_MUTED, font=(FONT, 9), anchor="w",
                 justify="left", wraplength=720).pack(fill="x", pady=(6, 8))
        btns = tk.Frame(foot, bg=C_BG)
        btns.pack(fill="x")
        self.go = ttk.Button(btns, text="▶  Make video", style="Accent.TButton", command=self.start)
        self.go.pack(side="right")
        self.open_btn = ttk.Button(btns, text="Open folder", command=self.open_folder, state="disabled")
        self.open_btn.pack(side="right", padx=(0, 10))

        self.refresh_check()
        if not find_tool("ffmpeg"):
            self.status.set("FFmpeg is not installed – run Setup.bat once (or: winget install Gyan.FFmpeg), then reopen this tool.")

    # ----- look -----

    def _styles(self):
        st = ttk.Style(self)
        st.theme_use("clam")
        st.configure(".", font=(FONT, 10), foreground=C_INK)
        st.configure("Card.TFrame", background=C_CARD)
        st.configure("Card.TLabel", background=C_CARD)
        st.configure("Field.TLabel", background=C_CARD, font=(FONT, 10, "bold"))
        st.configure("Muted.TLabel", background=C_CARD, foreground=C_MUTED, font=(FONT, 9))
        st.configure("Title.TLabel", background=C_CARD, font=(FONT, 12, "bold"))
        st.configure("Step.TLabel", background=C_ACCENT, foreground="white", font=(FONT, 9, "bold"),
                     padding=(7, 1), anchor="center")
        st.configure("TCheckbutton", background=C_CARD, padding=2)
        st.map("TCheckbutton", background=[("active", C_CARD)])
        st.configure("TEntry", padding=6, fieldbackground="white", bordercolor=C_LINE, lightcolor=C_LINE)
        st.map("TEntry", bordercolor=[("focus", C_ACCENT)], lightcolor=[("focus", C_ACCENT)])
        st.configure("TCombobox", padding=4, fieldbackground="white", bordercolor=C_LINE)
        st.map("TCombobox", fieldbackground=[("readonly", "white")])
        st.configure("TButton", padding=(12, 6), background="#EEF1F7", bordercolor=C_LINE,
                     lightcolor="#EEF1F7", darkcolor="#EEF1F7")
        st.map("TButton", background=[("active", "#E2E7F1"), ("disabled", "#F3F5FA")],
               foreground=[("disabled", "#A0A7B4")])
        st.configure("Accent.TButton", padding=(26, 10), font=(FONT, 11, "bold"), foreground="white",
                     background=C_ACCENT, bordercolor=C_ACCENT, lightcolor=C_ACCENT, darkcolor=C_ACCENT)
        st.map("Accent.TButton", background=[("disabled", "#9DB6EE"), ("active", C_ACCENT_DOWN)],
               foreground=[("disabled", "white")])
        st.configure("Accent.Horizontal.TProgressbar", thickness=10, background=C_ACCENT, troughcolor="#E3E7EF",
                     bordercolor="#E3E7EF", lightcolor=C_ACCENT, darkcolor=C_ACCENT)

    def _card(self, parent, step, title):
        outer = tk.Frame(parent, bg=C_CARD, highlightthickness=1, highlightbackground=C_LINE)
        outer.pack(fill="x", pady=(0, 10))
        top = ttk.Frame(outer, style="Card.TFrame", padding=(16, 10, 16, 2))
        top.pack(fill="x")
        ttk.Label(top, text=step, style="Step.TLabel").pack(side="left")
        ttk.Label(top, text=title, style="Title.TLabel").pack(side="left", padx=(10, 0))
        inner = ttk.Frame(outer, style="Card.TFrame", padding=(16, 4, 16, 12))
        inner.pack(fill="x")
        # Same column widths in every card, so the boxes line up.
        inner.columnconfigure(0, minsize=250)
        inner.columnconfigure(1, weight=1)
        inner.columnconfigure(2, minsize=150)
        return inner

    def _file_row(self, parent, row, label, hint, var, browse, clear=False, top=0):
        r = row
        names = ttk.Frame(parent, style="Card.TFrame")
        names.grid(row=r, column=0, sticky="nw", pady=(top + 3, 3), padx=(0, 14))
        ttk.Label(names, text=label, style="Field.TLabel").pack(anchor="w")
        ttk.Label(names, text=hint, style="Muted.TLabel").pack(anchor="w")
        ttk.Entry(parent, textvariable=var, width=46).grid(row=r, column=1, sticky="we", pady=(top + 3, 3))
        btns = ttk.Frame(parent, style="Card.TFrame")
        btns.grid(row=r, column=2, sticky="w", pady=(top + 3, 3), padx=(8, 0))
        ttk.Button(btns, text="Browse…", command=browse).pack(side="left")
        if clear:
            ttk.Button(btns, text="✕", width=3, command=lambda: (var.set(""), self.refresh_check())).pack(side="left", padx=(4, 0))

    # ----- the Check panel -----

    def write_report(self, items):
        """items: [(tag, text)] – tag ok / bad / warn / muted / quote / head."""
        self.report.configure(state="normal")
        self.report.delete("1.0", "end")
        for tag, text in items:
            self.report.insert("end", text + "\n", tag)
        self.report.configure(state="disabled")

    def add_report(self, items):
        self.report.configure(state="normal")
        for tag, text in items:
            self.report.insert("end", text + "\n", tag)
        self.report.configure(state="disabled")
        self.report.see("end")

    def check_items(self, plan):
        n_img = sum(len(s) for s in plan["scenes"])
        if not plan["script"]:
            return [("ok", f"✓  {n_img} image(s)."),
                    ("warn", "⚠  No script or scenes.txt – every image gets an equal share of the audio "
                             "(no subtitles, no chapters).")]
        src = ("scenes.txt in the folder" if plan["script"].name == "scenes.txt" and not self.script.get().strip()
               else plan["script"].name)
        items = [("ok", f"✓  {len(plan['scenes'])} scenes from {src}  ·  {n_img} image(s)"
                        + (f"  ·  {len(plan['chapters'])} chapters" if plan["chapters"] else ""))]
        if plan["missing"]:
            items.append(("bad", f"✗  No image for {len(plan['missing'])} scene(s) – the previous image stays on screen:"))
            for n in plan["missing"][:15]:
                items.append(("quote", f"Scene {n}:  “{cut(plan['lines'][n - 1])}”"))
            if len(plan["missing"]) > 15:
                items.append(("quote", f"… and {len(plan['missing']) - 15} more"))
        else:
            items.append(("ok", "✓  Every scene has an image"))
        empty = [i + 1 for i, line in enumerate(plan["lines"]) if not line.strip()]
        if empty:
            items.append(("warn", f"⚠  No narration written for scene(s) {', '.join(map(str, empty[:20]))}"))
        if plan["extra"]:
            items.append(("muted", f"•  {len(plan['extra'])} other image(s) don't belong to a scene and are left out"))
        tagged = {}
        for i, tags in enumerate(plan.get("tags") or []):
            for t in sorted(tags):
                tagged.setdefault(t, []).append(str(i + 1))
        if tagged:
            items.append(("ok", "✓  Scene effects: " + "  ·  ".join(
                f"[{t}] scene {', '.join(n[:8])}{'…' if len(n) > 8 else ''}" for t, n in tagged.items())))
        items.append(("muted", "•  Whether every narration line is in the audio is checked when you click Make video."))
        return items

    def refresh_check(self):
        folder = self.folder.get().strip()
        if not (folder and Path(folder).is_dir()):
            self.write_report([("muted", "Pick the images folder – the scenes and images are checked here.")])
            return
        if not self.output and self.audio.get().strip():
            self.status.set("Ready – click Make video.")
        try:
            self.write_report(self.check_items(plan_scenes(folder, self.first_only.get(), self.script.get().strip() or None)))
        except Exception as e:
            self.write_report([("bad", f"✗  {e}")])

    # ----- pickers -----

    def pick_folder(self):
        d = filedialog.askdirectory(title="Folder with the images")
        if d:
            self.folder.set(d)
            self.refresh_check()

    def pick_audio(self):
        f = filedialog.askopenfilename(title="Narration audio", filetypes=AUDIO_TYPES)
        if f:
            self.audio.set(f)
            self.refresh_check()

    def pick_music(self):
        f = filedialog.askopenfilename(title="Background music", filetypes=AUDIO_TYPES)
        if f:
            self.music.set(f)

    def pick_script(self):
        f = filedialog.askopenfilename(title="Narration script", filetypes=SCRIPT_TYPES)
        if f:
            self.script.set(f)
            self.refresh_check()

    def open_folder(self):
        if self.output:
            os.startfile(self.output.parent)

    # ----- run -----

    def start(self):
        folder, audio, script = self.folder.get().strip(), self.audio.get().strip(), self.script.get().strip()
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
            self.write_report([("bad", f"✗  {e}")])
            return messagebox.showerror("Make Video", str(e))
        self.write_report(self.check_items(plan))
        if not any(plan["scenes"]):
            return messagebox.showwarning("Make Video", "No images (.png/.jpg/.webp) in that folder.")
        if plan["missing"]:
            listed = "\n".join(f"  Scene {n}: “{cut(plan['lines'][n - 1], 70)}”" for n in plan["missing"][:12])
            more = f"\n  … and {len(plan['missing']) - 12} more" if len(plan["missing"]) > 12 else ""
            if not messagebox.askyesno(
                "Make Video",
                f"These scenes have no image (failed or deleted):\n\n{listed}{more}\n\n"
                "Make the video anyway? The previous image stays on screen while this narration is spoken.\n\n"
                "Or click No, use \"Retry failed\" in Flow Batch, and come back.",
                icon="warning",
            ):
                return
        output = Path(folder) / f"{Path(folder).name}.mp4"
        n_images = sum(len(s) for s in plan["scenes"])

        self.go.config(state="disabled")
        self.open_btn.config(state="disabled")
        self.bar["value"] = 0

        def progress(frac):
            self.after(0, lambda: self.bar.configure(value=frac))

        def status(text):
            self.after(0, lambda: self.status.set(text))

        def confirm(msg, scenes):
            # Called from the worker thread: show the missing narration in the Check
            # panel, ask in the window and wait for the answer.
            done, answer = threading.Event(), []

            def ask():
                items = [("bad", f"✗  Narration not in the audio for {len(scenes)} scene(s) (not recorded, or cut out):")]
                items += [("quote", f"Scene {n}:  “{cut(text)}”") for n, text in scenes[:15]]
                if len(scenes) > 15:
                    items.append(("quote", f"… and {len(scenes) - 15} more"))
                self.add_report(items)
                answer.append(messagebox.askyesno("Make Video", msg, icon="warning"))
                done.set()

            self.after(0, ask)
            done.wait()
            return answer[0]

        def work():
            try:
                total, durations, note, extra = build_video(
                    plan, audio, output, self.bg.get(), progress, status,
                    motion=MOTION_MODES.get(self.motion.get(), "off"), crossfade=self.crossfade.get(),
                    music=music or None, music_level=self.music_level.get(),
                    burn_subs=self.subs.get(), confirm=confirm,
                )
                mode = "matched to the narration" if plan["script"] else "equal timing"
                items = [("ok", f"✓  Done:  {output.name}  ·  {int(total // 60)}:{int(total % 60):02d}  ·  "
                                f"{n_images} images, {mode}")]
                if plan["script"]:
                    items.append(("muted", f"•  {note}"))
                if self.subs.get() and not plan["script"]:
                    items.append(("warn", "⚠  No subtitles on the video – they need a script (scenes.txt)."))
                items.append(("muted", "•  Also saved: " + ", ".join([f"{output.stem}_timings.csv"] + extra)))
                self.after(0, lambda: self.finish(items, output))
            except Exception as e:  # show any failure in the window
                err = str(e)
                self.after(0, lambda: self.finish([("bad", f"✗  {err}")], None))

        threading.Thread(target=work, daemon=True).start()

    def finish(self, items, output):
        self.go.config(state="normal")
        self.add_report(items)
        if output:
            self.output = output
            self.bar["value"] = 1.0
            self.status.set(f"Finished – {output}")
            self.open_btn.config(state="normal")
        else:
            self.bar["value"] = 0
            self.status.set("Stopped.")
            messagebox.showerror("Make Video", items[0][1].lstrip("✗ "))


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    if os.name == "nt":
        try:  # sharp text on high-DPI screens
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    App().mainloop()
