"""Flow Batch – Make Video.

Turns a folder of images + one audio file into a 1920x1080 MP4 for YouTube.
Images are shown in file-name order, each for an equal share of the audio.

Double-click "Make Video.bat" (or run: python make_video.py).
Needs FFmpeg (install once with:  winget install Gyan.FFmpeg).
"""

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
WIDTH, HEIGHT, FPS = 1920, 1080, 30
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


# ---------- build ----------

def build_video(images, audio, output, background, on_progress):
    ffmpeg, ffprobe = find_tool("ffmpeg"), find_tool("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("FFmpeg is not installed.\n\nInstall it once by running this in a terminal:\n\nwinget install Gyan.FFmpeg\n\nthen open this tool again.")

    total = audio_duration(ffprobe, audio)
    per = total / len(images)

    with tempfile.TemporaryDirectory(prefix="flowbatch_") as tmp:
        tmp = Path(tmp)

        # Step 1 (first 30 % of the bar): bring every image to exactly 1920x1080
        # with borders. Joining images of different sizes directly makes FFmpeg
        # drop frames, so they must all match first.
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
            on_progress(0.3 * (i + 1) / len(images))

        # Step 2: ffmpeg "concat" list – each frame with its duration
        # (the last one repeated, as ffmpeg requires).
        lines = []
        for frame in frames:
            lines += [f"file '{frame.as_posix()}'", f"duration {per:.4f}"]
        lines.append(f"file '{frames[-1].as_posix()}'")
        list_file = tmp / "list.txt"
        list_file.write_text("\n".join(lines), encoding="utf-8")

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
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
        for line in proc.stdout:
            if line.startswith("out_time_us="):
                try:
                    on_progress(0.3 + 0.7 * min(1.0, int(line.split("=")[1]) / 1e6 / total))
                except ValueError:
                    pass
        err = proc.stderr.read()
        if proc.wait() != 0:
            raise RuntimeError(f"FFmpeg failed:\n{err.strip()[-1500:]}")
    return total, per


# ---------- window ----------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Flow Batch – Make Video")
        self.resizable(False, False)
        self.folder = tk.StringVar()
        self.audio = tk.StringVar()
        self.first_only = tk.BooleanVar(value=True)
        self.bg = tk.StringVar(value="white")
        self.status = tk.StringVar(value="Pick the images folder and the audio file.")

        pad = {"padx": 10, "pady": 5}
        frm = ttk.Frame(self, padding=12)
        frm.grid()

        ttk.Label(frm, text="1. Images folder").grid(row=0, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.folder, width=55).grid(row=0, column=1, **pad)
        ttk.Button(frm, text="Browse…", command=self.pick_folder).grid(row=0, column=2, **pad)

        ttk.Label(frm, text="2. Audio file").grid(row=1, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.audio, width=55).grid(row=1, column=1, **pad)
        ttk.Button(frm, text="Browse…", command=self.pick_audio).grid(row=1, column=2, **pad)

        opts = ttk.Frame(frm)
        opts.grid(row=2, column=0, columnspan=3, sticky="w", **pad)
        ttk.Checkbutton(opts, text="Only the first image of each prompt (001_…_1)", variable=self.first_only,
                        command=self.refresh_count).pack(side="left")
        ttk.Label(opts, text="   Border colour:").pack(side="left")
        ttk.Combobox(opts, textvariable=self.bg, values=["white", "black"], width=7, state="readonly").pack(side="left")

        self.count = ttk.Label(frm, text="")
        self.count.grid(row=3, column=0, columnspan=3, sticky="w", **pad)

        self.bar = ttk.Progressbar(frm, length=560, maximum=1.0)
        self.bar.grid(row=4, column=0, columnspan=3, **pad)
        ttk.Label(frm, textvariable=self.status, wraplength=560).grid(row=5, column=0, columnspan=3, sticky="w", **pad)

        self.go = ttk.Button(frm, text="3. Make video", command=self.start)
        self.go.grid(row=6, column=0, columnspan=3, pady=(6, 2))

        if not find_tool("ffmpeg"):
            self.status.set("FFmpeg is not installed – run  winget install Gyan.FFmpeg  once, then reopen this tool.")

    def pick_folder(self):
        d = filedialog.askdirectory(title="Folder with the images")
        if d:
            self.folder.set(d)
            self.refresh_count()

    def pick_audio(self):
        f = filedialog.askopenfilename(title="Audio file", filetypes=AUDIO_TYPES)
        if f:
            self.audio.set(f)

    def refresh_count(self):
        if self.folder.get() and Path(self.folder.get()).is_dir():
            n = len(pick_images(self.folder.get(), self.first_only.get()))
            self.count.config(text=f"{n} image(s) will be used, in file-name order.")

    def start(self):
        folder, audio = self.folder.get(), self.audio.get()
        if not folder or not Path(folder).is_dir():
            return messagebox.showwarning("Make Video", "Pick the images folder first.")
        if not audio or not Path(audio).is_file():
            return messagebox.showwarning("Make Video", "Pick the audio file first.")
        images = pick_images(folder, self.first_only.get())
        if not images:
            return messagebox.showwarning("Make Video", "No images (.png/.jpg/.webp) in that folder.")
        output = Path(folder) / f"{Path(folder).name}.mp4"

        self.go.config(state="disabled")
        self.bar["value"] = 0
        self.status.set(f"Making the video from {len(images)} images…")

        def progress(frac):
            self.after(0, lambda: self.bar.configure(value=frac))

        def work():
            try:
                total, per = build_video(images, audio, output, self.bg.get(), progress)
                msg = f"Done! {output}\n{len(images)} images × {per:.1f} s = {total:.0f} s"
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
