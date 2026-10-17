"""
Audio prep: raw CC0 recordings (E:/tmp/island/raw/audio, from scripts/fetch-audio.ts, plus River Morning's CC0
footsteps/splashes) -> game files in public/assets/audio/:

  amb_*.ogg    seamless loops (a 40-60 s cut, loudness-normalised, end cross-faded into the start)
  step_*.ogg   single footsteps cut at the onsets of a walking recording
  thunder_*    one-shots

  python tools/prep_audio.py
"""
import json, os, subprocess, sys, shutil
import numpy as np

RAW = "E:/tmp/island/raw/audio"
RM = "C:/Code/river-morning/public/assets/audio"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "audio")
os.makedirs(OUT, exist_ok=True)
SR = 44100
meta = json.load(open(f"{RAW}/meta.json"))
log = {}


def decode(path, start=0.0, dur=None, mono=False):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start)]
    if dur:
        cmd += ["-t", str(dur)]
    cmd += ["-i", path, "-f", "f32le", "-ac", "1" if mono else "2", "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.float32)
    return a if mono else a.reshape(-1, 2)


def encode(a, out, q=4):
    ch = 1 if a.ndim == 1 else 2
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", str(ch), "-ar", str(SR), "-i", "-",
                        "-c:a", "libvorbis", "-q:a", str(q), out], input=a.astype(np.float32).tobytes(), capture_output=True)
    if p.returncode != 0:
        print(p.stderr.decode()[:400])


def loudness(a, target=-20.0):
    rms = np.sqrt(np.mean(a.astype(np.float64) ** 2) + 1e-12)
    db = 20 * np.log10(rms)
    g = 10 ** ((target - db) / 20)
    out = a * g
    peak = np.max(np.abs(out))
    if peak > 0.95:
        out *= 0.95 / peak
    return out


def make_loop(src, out, length=48.0, xfade=4.0, start=3.0, target=-20.0):
    a = decode(src, start, length + xfade)
    if len(a) < SR * (xfade * 2 + 5):
        a = decode(src, 0, None)
    n = len(a)
    X = int(xfade * SR)
    if n <= 2 * X:
        X = n // 4
    body = a[: n - X].copy()
    tail = a[n - X:]
    ramp = np.linspace(0, 1, X)[:, None] if a.ndim == 2 else np.linspace(0, 1, X)
    # equal-power cross-fade of the tail into the head
    body[:X] = body[:X] * np.sqrt(ramp) + tail * np.sqrt(1 - ramp)
    body = loudness(body, target)
    encode(body, out)
    return len(body) / SR


def slice_steps(src, prefix, count=4, target=-16.0, pre=0.02, length=0.42):
    a = decode(src, 0, 60, mono=True)
    win = int(0.01 * SR)
    env = np.sqrt(np.convolve(a ** 2, np.ones(win) / win, mode="same"))
    thr = np.percentile(env, 92) * 0.6
    peaks = []
    i = 0
    min_gap = int(0.28 * SR)
    while i < len(env):
        if env[i] > thr:
            j = i + np.argmax(env[i:i + int(0.08 * SR)])
            peaks.append(j)
            i = j + min_gap
        else:
            i += win
    if not peaks:
        print("no onsets in", src)
        return 0
    # strongest few, spread across the recording
    peaks = sorted(peaks, key=lambda p: -env[p])[: max(count * 3, count)]
    peaks = sorted(peaks)[:: max(1, len(peaks) // count)][:count]
    made = 0
    for k, p in enumerate(peaks):
        s0 = max(0, p - int(pre * SR) - int(0.03 * SR))
        seg = a[s0: s0 + int(length * SR)].copy()
        if len(seg) < 1000:
            continue
        fade = np.linspace(1, 0, len(seg)) ** 2
        seg *= fade
        seg[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
        seg = loudness(seg, target)
        encode(seg, os.path.join(OUT, f"{prefix}_{k + 1}.ogg"))
        made += 1
    return made


def first(key):
    v = meta.get(key) or []
    return v[0]["file"] if v else None


loops = {
    "amb_waves": ((meta.get("waves") or [{}, {}])[1].get("file") or first("waves_b"), -18),
    "amb_surf": (first("surf") or first("waves_b"), -22),
    "amb_wind": (first("wind"), -22),
    "amb_birds": (first("birds"), -21),
    "amb_jungle": (first("birds"), -24),
    "amb_night": (first("night"), -21),
    "amb_rain": (first("rain"), -19),
    "amb_rain_heavy": (first("rain_heavy") or first("rain"), -18),
    "amb_waterfall": (first("waterfall"), -17),
    "amb_stream": (f"{RM}/amb_river_calm.ogg", -21),
    "amb_chimes": (first("chimes"), -24),
    "amb_chickens": (first("chickens"), -24),
    "amb_creak": (first("creak"), -23),
    "amb_gulls": (first("gulls"), -24),
}
for name, (src, tgt) in loops.items():
    if not src or not os.path.exists(src):
        print("missing", name)
        continue
    d = make_loop(src, os.path.join(OUT, f"{name}.ogg"), target=tgt)
    log[name] = {"src": src, "seconds": round(d, 1)}
    print(f"{name}: {d:.1f} s <- {os.path.basename(src)}")

# thunder one-shots
for i, h in enumerate(meta.get("thunder", [])[:3]):
    a = loudness(decode(h["file"], 0, 14), -16)
    a *= np.minimum(1, np.linspace(1, 0, len(a)) * 4)[:, None]
    encode(a, os.path.join(OUT, f"thunder_{i + 1}.ogg"))
    print("thunder", i + 1)

# footsteps: new recordings sliced, River Morning's CC0 one-shots copied
for key, prefix in [("steps_sand", "step_sand"), ("steps_leaves", "step_leaves"), ("steps_stone", "step_stone"),
                    ("steps_water", "step_water"), ("steps_metal", "step_metal"), ("swim", "swim")]:
    src = first(key)
    if src and os.path.exists(src):
        n = slice_steps(src, prefix, 4 if prefix != "swim" else 3, length=0.42 if prefix != "swim" else 0.9)
        print(prefix, n)
for src, dst in [("sfx_step_grass_0%d", "step_grass_%d"), ("sfx_step_gravel_0%d", "step_gravel_%d"), ("sfx_step_wood_0%d", "step_wood_%d")]:
    for i in range(1, 5):
        shutil.copy(f"{RM}/{src % i}.ogg", os.path.join(OUT, f"{dst % i}.ogg"))
shutil.copy(f"{RM}/sfx_splash_big_01.ogg", os.path.join(OUT, "splash_big.ogg"))
shutil.copy(f"{RM}/sfx_splash_small_01.ogg", os.path.join(OUT, "splash_small.ogg"))
# fallbacks so every surface has sounds
for prefix, fb in [("step_leaves", "step_grass"), ("step_stone", "step_gravel"), ("step_water", "step_sand"), ("step_metal", "step_wood"), ("step_sand", "step_gravel")]:
    for i in range(1, 5):
        p = os.path.join(OUT, f"{prefix}_{i}.ogg")
        if not os.path.exists(p):
            shutil.copy(os.path.join(OUT, f"{fb}_{i}.ogg"), p)
for i in range(1, 4):
    p = os.path.join(OUT, f"swim_{i}.ogg")
    if not os.path.exists(p):
        shutil.copy(os.path.join(OUT, "splash_small.ogg"), p)
json.dump(log, open("E:/tmp/island/audio_prep.json", "w"), indent=1)
print("done")
