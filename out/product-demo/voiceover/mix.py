#!/usr/bin/env python3
"""Add the voiceover, captions and a SAMPLE DATA stamp to a recorded take.

  python3 out/product-demo/voiceover/mix.py full-demo

Reads  out/product-demo/<name>.mp4, <name>.scenes.json (written by the take),
       voiceover/narration.json and voiceover/<scene>.aiff (from `say`).
Writes out/product-demo/<name>-voiceover.mp4 (voice + soft captions + stamp)
       and out/product-demo/<name>.srt.
Everything runs locally with ffmpeg and ImageMagick.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

name = sys.argv[1] if len(sys.argv) > 1 else "full-demo"
root = Path("out/product-demo")
vo = root / "voiceover"
video = root / f"{name}.mp4"
scenes = json.loads((root / f"{name}.scenes.json").read_text())
fps = scenes["fps"]
text = {s["id"]: s["text"] for s in json.loads((vo / "narration.json").read_text())}


def probe(path, entry):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", entry, "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    return out


video_seconds = float(probe(video, "format=duration")[0])
width, height = map(int, probe(video, "stream=width,height")[:2])

# 1. Voice track: each clip delayed to its scene's start frame.
clips = []
for scene in scenes["scenes"]:
    clip = vo / f"{scene['id']}.aiff"
    start = scene["frame"] / fps
    clips.append((scene["id"], clip, start, float(probe(clip, "format=duration")[0])))

inputs, filters = [], []
for i, (_, clip, start, _) in enumerate(clips):
    inputs += ["-i", str(clip)]
    ms = round(start * 1000)
    filters.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(clips)))
filters.append(f"{mix}amix=inputs={len(clips)}:normalize=0,apad=whole_dur={video_seconds:.3f}[voice]")
voice = vo / f"{name}-voice.m4a"
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters),
     "-map", "[voice]", "-ac", "2", "-c:a", "aac", "-b:a", "160k", "-t", f"{video_seconds:.3f}", str(voice)],
    check=True,
)

# 2. Captions: one cue per sentence, timed by share of characters within the clip.
def stamp(seconds):
    ms = round(seconds * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


cues = []
for scene_id, _, start, duration in clips:
    sentences = [s for s in re.split(r"(?<=[.!?:])\s+", text[scene_id]) if s]
    total = sum(len(s) for s in sentences)
    t = start
    for sentence in sentences:
        length = duration * len(sentence) / total
        cues.append((t, t + length, sentence))
        t += length
srt = root / f"{name}.srt"
srt.write_text(
    "\n".join(f"{i}\n{stamp(a)} --> {stamp(b)}\n{line}\n" for i, (a, b, line) in enumerate(cues, 1)),
    encoding="utf-8",
)

# 3. SAMPLE DATA stamp, sized for the encoded width.
badge = vo / "sample-stamp.png"
point = max(12, round(width / 70))
subprocess.run(
    ["magick", "-background", "#2a2208", "-fill", "#f5b942", "-font", "Helvetica", "-pointsize", str(point),
     "label: SAMPLE DATA: synthetic demo, not real audits ", str(badge)],
    check=True,
)

# 4. Mux: stamp over the video, voice, soft captions.
final = root / f"{name}-voiceover.mp4"
margin = max(6, round(width / 120))
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-i", str(badge), "-i", str(voice), "-i", str(srt),
     "-filter_complex", f"[0:v][1:v]overlay=W-w-{margin}:{margin}[v]",
     "-map", "[v]", "-map", "2:a", "-map", "3:s",
     "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p",
     "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
     "-metadata:s:a:0", "title=Voiceover (macOS say, Samantha)",
     "-movflags", "+faststart", str(final)],
    check=True,
)
print(f"{final}  {video_seconds:.1f}s  {final.stat().st_size / 1e6:.1f} MB")
print(f"{srt}  {len(cues)} cues")
