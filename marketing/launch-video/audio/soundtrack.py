#!/usr/bin/env python3
"""Hovod launch film — procedural soundtrack.

Reads audio/cues.json (exported from the composition by scripts/export-cues.sh) and writes
audio/soundtrack-raw.wav: a 120 BPM score arranged on the film's sections, plus sound effects
placed on the exact times the timeline recorded. Fully synthesized and deterministic (fixed
seeds, no samples), so the music always lands on the cuts.

    python3 audio/soundtrack.py            # -> audio/soundtrack-raw.wav (float mix, peak -3 dBFS)
    ffmpeg ... loudnorm                    # -> audio/soundtrack.wav (-14 LUFS, see README)

Requires numpy and scipy.
"""
import json
import os
import sys
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt, sosfilt_zi

SR = 48000
BPM = 120
BEAT = 60.0 / BPM
BAR = 4 * BEAT
HERE = os.path.dirname(os.path.abspath(__file__))

cues_doc = json.load(open(os.path.join(HERE, "cues.json")))
DUR = float(cues_doc["duration"])
N = int(SR * DUR)
CUES = cues_doc["cues"]


# ── primitives ──────────────────────────────────────────────────────────────
def midi_hz(m):
    return 440.0 * 2.0 ** ((np.asarray(m, float) - 69.0) / 12.0)


def rng(seed):
    return np.random.default_rng(seed)


def blep(ph, dt):
    r = np.zeros_like(ph)
    a = ph < dt
    x = ph[a] / dt[a]
    r[a] = x + x - x * x - 1.0
    b = ph > 1.0 - dt
    x = (ph[b] - 1.0) / dt[b]
    r[b] = x * x + x + x + 1.0
    return r


def phase(freq, n, p0=0.0):
    dt = np.broadcast_to(np.asarray(freq, float) / SR, (n,)).copy()
    ph = (p0 + np.cumsum(dt) - dt) % 1.0
    return ph, dt


def saw(freq, n, p0=0.0):
    ph, dt = phase(freq, n, p0)
    return 2.0 * ph - 1.0 - blep(ph, dt)


def sine(freq, n, p0=0.0):
    ph, _ = phase(freq, n, p0)
    return np.sin(2 * np.pi * ph)


def noise(n, seed):
    return rng(seed).standard_normal(n)


def env_exp(n, tau, attack=0.002):
    t = np.arange(n) / SR
    e = np.exp(-t / tau)
    a = max(1, int(attack * SR))
    e[:a] *= np.linspace(0, 1, a)
    return e


def env_adsr(n, a, d, s, r_len, hold):
    """attack/decay (s), sustain level, release (s) after `hold` seconds."""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = t > hold
    if rel.any():
        level = e[np.argmax(rel) - 1] if np.argmax(rel) > 0 else s
        e[rel] = level * np.exp(-(t[rel] - hold) / max(r_len / 4.6, 1e-4))
    return e


def fade(x, fin=0.003, fout=0.01):
    n = len(x)
    a, b = min(n, int(fin * SR)), min(n, int(fout * SR))
    if a > 0:
        x[:a] *= np.linspace(0, 1, a)
    if b > 0:
        x[n - b:] *= np.linspace(1, 0, b)
    return x


def sos(kind, fc, q=None, order=2):
    fc = np.clip(fc, 20, SR / 2 * 0.95)
    if kind == "bp":
        lo, hi = fc
        return butter(order, [max(lo, 20), min(hi, SR / 2 * 0.95)], btype="bandpass", fs=SR, output="sos")
    return butter(order, fc, btype={"lp": "lowpass", "hp": "highpass"}[kind], fs=SR, output="sos")


def filt(x, kind, fc, order=2):
    return sosfilt(sos(kind, fc, order=order), x, axis=0)


def sweep_lp(x, fc_curve, block=256, order=2):
    """Low-pass with a time-varying cutoff (one value per sample), processed in short blocks."""
    y = np.empty_like(x)
    zi = None
    for i in range(0, len(x), block):
        fc = float(np.clip(fc_curve[min(i + block // 2, len(x) - 1)], 30, SR * 0.45))
        s = sos("lp", fc, order=order)
        if zi is None:
            zi = sosfilt_zi(s) * x[0]
        y[i:i + block], zi = sosfilt(s, x[i:i + block], zi=zi)
    return y


def sweep_bp(x, lo_curve, width=1.0, block=256):
    y = np.empty_like(x)
    zi = None
    for i in range(0, len(x), block):
        c = float(np.clip(lo_curve[min(i + block // 2, len(x) - 1)], 60, SR * 0.4))
        s = sos("bp", (c / (1 + width / 2), c * (1 + width / 2)), order=1)
        if zi is None:
            zi = np.zeros((s.shape[0], 2))
        y[i:i + block], zi = sosfilt(s, x[i:i + block], zi=zi)
    return y


class Bus:
    def __init__(self):
        self.x = np.zeros((N, 2))

    def add(self, sig, t, gain=1.0, pan=0.0):
        i = int(round(t * SR))
        if i >= N:
            return
        sig = np.asarray(sig, float)
        if i < 0:
            sig = sig[-i:]
            i = 0
        n = min(len(sig), N - i)
        if n <= 0:
            return
        if sig.ndim == 1:
            p = (pan + 1) * np.pi / 4
            self.x[i:i + n, 0] += sig[:n] * gain * np.cos(p)
            self.x[i:i + n, 1] += sig[:n] * gain * np.sin(p)
        else:
            self.x[i:i + n] += sig[:n] * gain


def times(start, end, step, offset=0.0):
    out = []
    k = 0
    while True:
        t = start + offset + k * step
        if t >= end - 1e-9:
            break
        out.append(round(t, 6))
        k += 1
    return out


# ── reverb ──────────────────────────────────────────────────────────────────
def make_ir(seconds=2.6, seed=77, predelay=0.02, bright=6500):
    n = int(SR * seconds)
    t = np.arange(n) / SR
    env = np.exp(-t * 6.9 / seconds)
    r = rng(seed)
    ir = np.stack([r.standard_normal(n), r.standard_normal(n)], 1) * env[:, None]
    ir = filt(ir, "lp", bright)
    ir = filt(ir, "hp", 180)
    # early reflections
    for k, (dl, g) in enumerate([(0.011, 0.5), (0.019, 0.4), (0.027, 0.33), (0.041, 0.25)]):
        j = int(dl * SR)
        ir[j, k % 2] += g
    pd = int(predelay * SR)
    ir = np.concatenate([np.zeros((pd, 2)), ir])
    return ir / np.sqrt((ir ** 2).sum() / 2)


def reverb(x, ir):
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[:N] for c in range(2)], 1)
    return y


# ── score ───────────────────────────────────────────────────────────────────
SECTION = cues_doc["sections"]
CH = {
    "Dm_dark": ([50, 53, 57], 38),
    "Bb/D": ([50, 53, 58], 38),
    "A/D": ([49, 52, 57], 38),
    "Bbmaj9": ([53, 57, 60, 62], 34),
    "F/A": ([53, 57, 60, 67], 33),
    "Gm9": ([53, 57, 58, 62], 31),
    "Csus": ([53, 55, 60, 62], 36),
    "F": ([53, 57, 60, 67], 41),
    "C/E": ([52, 55, 60, 62], 40),
    "Dm9": ([53, 57, 60, 64], 38),
    "C": ([52, 55, 60, 64], 36),
    "Fmaj9": ([53, 57, 60, 64, 67], 41),
}
LOOP = ["F", "C/E", "Dm9", "Bbmaj9"]
PLAN = [(0, 4, "Dm_dark"), (4, 6, "Dm_dark"), (6, 8, "Bb/D"), (8, 9.75, "A/D"),
        (10, 12, "Bbmaj9"), (12, 14, "F/A"), (14, 15, "Gm9"), (15, 16, "Csus")]
for k, t0 in enumerate(np.arange(16, 48, 2.0)):
    PLAN.append((float(t0), float(t0) + 2, LOOP[k % 4]))
PLAN.append((48, 49.75, "C"))
for k, t0 in enumerate(np.arange(50, 58, 2.0)):
    PLAN.append((float(t0), float(t0) + 2, LOOP[k % 4]))
PLAN.append((58, 64, "Fmaj9"))


def in_ranges(t, ranges):
    return any(a - 1e-9 <= t < b - 1e-9 for a, b in ranges)


GROOVE = [(16, 44), (50, 58)]
KICKS = sorted(set(
    [4.0, 5.0, 6.0, 7.0] + times(8.0, 9.75, BEAT) + times(14.0, 16.0, 2 * BEAT) +
    times(16, 44, BEAT) + times(48, 49.75, BEAT) + times(50, 58, BEAT) + [44.0, 58.0]))
DUBS = [4.2, 5.2, 6.2, 7.2]  # heartbeat "dub"
CLAPS = [t for t in times(16, 44, BAR / 2, BEAT)] + [t for t in times(50, 58, BAR / 2, BEAT)]
HATS = times(14, 49.75, BEAT, BEAT / 2) + times(50, 58, BEAT, BEAT / 2)
GHOSTS = [t for t in times(24, 44, BEAT / 2, BEAT / 4)] + [t for t in times(50, 58, BEAT / 2, BEAT / 4)]
OPENS = times(36, 44, BEAT, BEAT / 2) + times(50, 58, BEAT, BEAT / 2)
SILENT = [(9.75, 10.0), (49.75, 50.0)]


def sidechain(kicks, depth=0.55, release=0.16):
    g = np.ones(N)
    L = int(0.45 * SR)
    t = np.arange(L) / SR
    a = int(0.004 * SR)
    curve = 1 - depth * np.exp(-t / release)
    curve[:a] = np.linspace(1, curve[a], a)
    for tk in kicks:
        i = int(tk * SR)
        n = min(L, N - i)
        if n > 0:
            g[i:i + n] = np.minimum(g[i:i + n], curve[:n])
    return g


# ── instruments ─────────────────────────────────────────────────────────────
def supersaw(m, n, seed, detune=0.16, voices=7):
    r = rng(seed)
    out = np.zeros((n, 2))
    offs = np.linspace(-detune, detune, voices)
    for k, o in enumerate(offs):
        f = midi_hz(m + o)
        v = saw(f, n, r.random())
        pan = np.linspace(-0.8, 0.8, voices)[k]
        p = (pan + 1) * np.pi / 4
        out[:, 0] += v * np.cos(p)
        out[:, 1] += v * np.sin(p)
    return out / voices


def kick(gain=1.0, punch=1.0):
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f = 44 + 120 * np.exp(-t / 0.035) * punch
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.2, 0.001)
    click = filt(noise(n, 3), "hp", 2500) * env_exp(n, 0.004, 0.0005) * 0.35
    return np.tanh(1.6 * (body + click)) * gain


def clap(seed=1):
    n = int(0.4 * SR)
    x = noise(n, seed)
    e = np.zeros(n)
    for k, d in enumerate([0, 0.011, 0.022, 0.031]):
        i = int(d * SR)
        e[i:] += env_exp(n - i, 0.012 if k < 3 else 0.09, 0.0008) * (0.8 if k < 3 else 1.0)
    return filt(x * e, "bp", (900, 3200)) * 0.9


def hat(open_=False, seed=2):
    n = int((0.32 if open_ else 0.06) * SR)
    x = filt(noise(n, seed), "hp", 7200)
    return x * env_exp(n, 0.09 if open_ else 0.014, 0.0005) * (0.5 if open_ else 0.55)


def snare(seed=4, tone=190):
    n = int(0.25 * SR)
    body = sine(tone, n) * env_exp(n, 0.05)
    nz = filt(noise(n, seed), "bp", (1500, 7000)) * env_exp(n, 0.07)
    return (0.5 * body + 0.8 * nz)


def pluck(m, dur=0.3, bright=3200, seed=0):
    n = int((dur + 0.25) * SR)
    f = midi_hz(m)
    x = 0.6 * saw(f, n, rng(seed).random()) + 0.4 * saw(f * 1.004, n, rng(seed + 1).random())
    fc = 350 + bright * np.exp(-np.arange(n) / SR / 0.07)
    y = sweep_lp(x, fc, block=128)
    return fade(y * env_exp(n, dur * 0.45, 0.002), 0.002, 0.03)


def bell(m, dur=1.2, index=2.2, ratio=3.5, gain=1.0):
    n = int(dur * SR)
    f = midi_hz(m)
    t = np.arange(n) / SR
    mod = np.sin(2 * np.pi * f * ratio * t) * index * np.exp(-t / (dur * 0.25))
    car = np.sin(2 * np.pi * f * t + mod)
    return fade(car * env_exp(n, dur * 0.32, 0.002) * gain, 0.002, 0.05)


def noise_sweep(dur, f0, f1, seed, width=1.2, shape="up"):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    if shape == "up":
        fc = f0 * (f1 / f0) ** t
        amp = t ** 1.6
    elif shape == "arc":
        fc = f0 * (f1 / f0) ** np.sin(np.pi * t)
        amp = np.sin(np.pi * t) ** 1.4
    else:
        fc = f0 * (f1 / f0) ** t
        amp = (1 - t) ** 2
    y = sweep_bp(noise(n, seed), fc, width=width)
    return fade(y * amp, 0.005, 0.02)


# ── build the score ─────────────────────────────────────────────────────────
drums, bass, pads, arps, bells, sfx, verb_send = Bus(), Bus(), Bus(), Bus(), Bus(), Bus(), Bus()

# kicks, heartbeat, claps, hats
for tk in KICKS:
    g = 1.0
    if tk < 10:
        g = 0.55 if tk < 8 else 0.62 + 0.1 * (tk - 8)
    elif tk < 16:
        g = 0.5
    elif 48 <= tk < 49.75:
        g = 0.55 + 0.25 * (tk - 48) / 1.75
    elif tk in (44.0,):
        g = 0.7
    drums.add(kick(g, punch=1.0 if tk >= 10 else 0.7), tk)
for td in DUBS:
    drums.add(kick(0.3, punch=0.6), td)
for tc in CLAPS:
    c = clap(int(tc * 10))
    drums.add(c, tc, 0.42)
    verb_send.add(c, tc, 0.18)
for th in HATS:
    lvl = 0.26 if (14 <= th < 16 or 44 <= th < 48) else 0.32
    drums.add(hat(False, int(th * 100)), th, lvl, pan=0.18)
for th in GHOSTS:
    drums.add(hat(False, int(th * 100) + 7), th, 0.12, pan=-0.22)
for th in OPENS:
    drums.add(hat(True, int(th * 100) + 3), th, 0.2, pan=0.1)
# snare roll into the second drop
roll = times(48.0, 49.0, BEAT / 2) + times(49.0, 49.5, BEAT / 4) + times(49.5, 49.75, BEAT / 8)
for k, ts in enumerate(roll):
    p = k / max(1, len(roll) - 1)
    drums.add(snare(20 + k, 180 + 90 * p), ts, 0.18 + 0.32 * p)
    verb_send.add(snare(20 + k, 180 + 90 * p), ts, 0.12)
# clock tick through the hook and the invoice
for tt in times(0.5, 9.75, BEAT / 2):
    n = int(0.03 * SR)
    tick = sine(3100, n) * env_exp(n, 0.006, 0.0005)
    drums.add(tick, tt, 0.05 if tt < 4 else 0.075, pan=0.35 if int(tt * 2) % 2 else -0.35)

# pads (supersaw, filtered per section) and sub bass
pad_raw = np.zeros((N, 2))
sub = np.zeros(N)
midbass = np.zeros(N)
for (a, b, name) in PLAN:
    notes, root = CH[name]
    rel = 1.6 if b >= 58 or name in ("Fmaj9",) else 0.35
    n = int((b - a + rel) * SR)
    i0 = int(a * SR)
    n = min(n, N - i0)
    env = env_adsr(n, 0.02 if a >= 10 else 0.6, 0.4, 0.85, rel, b - a)
    if name == "Fmaj9":
        env = env_adsr(n, 0.01, 1.2, 0.7, 3.5, b - a - 3.0)
    for k, m in enumerate(notes):
        v = supersaw(m, n, seed=int(a * 10) + k)
        pad_raw[i0:i0 + n] += v * env[:, None] * (0.9 if k else 1.0)
    # sub bass
    f = midi_hz(root)
    if a < 10:
        s = sine(f, n) * env * 0.8
    else:
        s = sine(f, n) * env
    sub[i0:i0 + n] += s[:n]
    # off-beat mid bass in the grooves
    if in_ranges(a, [(24, 44), (50, 58)]):
        for tb in times(a, b, BEAT, BEAT / 2):
            nb = int(0.22 * SR)
            x = saw(midi_hz(root + 12), nb) + 0.5 * saw(midi_hz(root + 12) * 1.005, nb)
            x = filt(x, "lp", 700) * env_exp(nb, 0.08, 0.002)
            j = int(tb * SR)
            m_ = min(nb, N - j)
            midbass[j:j + m_] += fade(x, 0.002, 0.02)[:m_] * 0.35

# pad colour: dark and closed in the hook, open at the drops, dipping in the breakdown
tt = np.arange(N) / SR
cut = np.interp(tt,
                [0, 4, 9.7, 9.75, 10, 12, 16, 30, 36, 44, 46, 48, 49.7, 50, 54, 58, 60, 64],
                [320, 520, 1400, 1400, 5200, 4200, 2600, 2800, 3400, 2600, 1100, 1300, 6800, 5200, 4200, 3800, 2600, 1400])
pad = np.stack([sweep_lp(pad_raw[:, c], cut, block=256) for c in range(2)], 1)
pad_level = np.interp(tt, [0, 3, 9.7, 10, 16, 44, 48, 50, 58, 62, 64], [0.35, 0.5, 0.75, 1.0, 0.8, 0.8, 0.95, 1.0, 1.0, 0.7, 0.0])
pads.x += pad * pad_level[:, None] * 0.7

sub = filt(sub, "lp", 180)
sub_level = np.interp(tt, [0, 4, 9.7, 10, 16, 44, 48, 50, 58, 62, 64], [0.5, 0.6, 0.7, 1.0, 0.85, 0.55, 0.85, 1.0, 1.0, 0.6, 0.0])
bass.x += np.stack([sub * sub_level, sub * sub_level], 1) * 0.3
bass.x += np.stack([midbass, midbass], 1) * 0.6

# pluck arpeggio, 16ths, with a dotted-eighth ping-pong delay
PATTERN = [0, 2, 4, 6, 7, 5, 3, 1, 2, 4, 6, 7, 5, 3, 1, 0]
arp_dry = Bus()
for (a, b, name) in PLAN:
    if not (16 <= a < 44 or 50 <= a < 58 or 12 <= a < 16):
        continue
    notes = sorted(CH[name][0])
    tones = [m + 12 for m in notes] + [m + 24 for m in notes]
    tones = (tones + tones)[:8]
    for k, ts in enumerate(times(a, b, BEAT / 4)):
        m = tones[PATTERN[k % 16] % len(tones)]
        vel = 0.55 if k % 4 == 0 else 0.38
        if 12 <= a < 16:
            vel *= 0.55
        if 44 <= a < 48:
            vel *= 0.8
        br = 2600 if a < 50 else 3600
        arp_dry.add(pluck(m, 0.22, br, seed=int(ts * 100)), ts, vel, pan=-0.25 if k % 2 else 0.25)
arp_dry.x *= 1.4
arps.x += arp_dry.x
d = int(0.375 * SR)
fb = 0.38
echo = np.zeros_like(arp_dry.x)
src = arp_dry.x.copy()
for k in range(1, 6):
    shifted = np.zeros_like(src)
    shifted[d * k:] = src[:-d * k]
    ch = k % 2
    echo[:, ch] += shifted[:, ch] * (fb ** k) + shifted[:, 1 - ch] * (fb ** k) * 0.3
arps.x += filt(echo, "lp", 4200) * 0.55
verb_send.x += arps.x * 0.18

# bells: AI sparkle, end motif
def add_bell(m, t, g, pan=0.0, dur=1.3):
    b = bell(m, dur)
    bells.add(b, t, g, pan)
    verb_send.add(b, t, g * 0.8, pan)


PENTA = [77, 79, 81, 84, 86, 89, 91]  # F G A C D (F major pentatonic, high)
for c in CUES:
    if c["type"] == "sparkle":
        r = rng(9)
        for k, ts in enumerate(times(c["t"], c["t"] + c.get("dur", 2.4), BEAT / 4)):
            if r.random() < 0.72:
                add_bell(PENTA[int(r.random() * len(PENTA))], ts, 0.1 * c["gain"], pan=float(r.uniform(-0.6, 0.6)), dur=0.9)
for k, (m, t) in enumerate([(84, 59.0), (81, 59.5), (79, 60.0), (81, 60.5), (77, 61.0)]):
    add_bell(m, t, 0.13, pan=[-0.3, 0.3, -0.15, 0.15, 0][k], dur=2.4)

# risers that the score needs on its own (into the groove)
sfx.add(noise_sweep(2.0, 300, 7000, 31) * 0.12, 14.0)


# ── sound effects on the timeline's cues ────────────────────────────────────
def fx_hit(g, big=False):
    n = int((1.2 if big else 0.6) * SR)
    t = np.arange(n) / SR
    f = 38 + (70 if big else 55) * np.exp(-t / (0.12 if big else 0.07))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.35 if big else 0.18, 0.001)
    nz = filt(noise(n, 5), "lp", 2200) * env_exp(n, 0.05, 0.001) * 0.5
    return np.tanh(1.4 * (body + nz)) * g


def fx_impact(g):
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    f = 28 + 80 * np.exp(-t / 0.25)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.9, 0.001)
    crack = filt(noise(n, 8), "hp", 900) * env_exp(n, 0.08, 0.0005) * 0.55
    air = filt(noise(n, 9), "bp", (2000, 9000)) * env_exp(n, 0.6, 0.01) * 0.15
    return np.tanh(1.3 * (boom + crack + air)) * g


def fx_click(g):
    n = int(0.06 * SR)
    a = filt(noise(n, 11), "bp", (1400, 5200)) * env_exp(n, 0.0025, 0.0003)
    b = np.zeros(n)
    j = int(0.028 * SR)
    b[j:] = filt(noise(n - j, 12), "bp", (1800, 6000)) * env_exp(n - j, 0.002, 0.0003) * 0.6
    return (a + b) * g


def fx_tick(g, f=2400):
    n = int(0.05 * SR)
    return sine(f, n) * env_exp(n, 0.009, 0.0005) * g


def fx_blip(g, f0=1300, f1=1900):
    n = int(0.09 * SR)
    f = np.linspace(f0, f1, n)
    return fade(sine(f, n) * env_exp(n, 0.035, 0.002) * g, 0.002, 0.01)


def fx_pop(g, f0=760, f1=260):
    n = int(0.12 * SR)
    f = f1 + (f0 - f1) * np.exp(-np.arange(n) / SR / 0.02)
    return fade(sine(f, n) * env_exp(n, 0.045, 0.001) * g, 0.001, 0.01)


def fx_print(g, seed):
    n = int(0.2 * SR)
    x = np.zeros(n)
    r = rng(seed)
    for k in range(11):
        j = int((k * 0.0125 + r.uniform(0, 0.002)) * SR)
        m = int(0.004 * SR)
        x[j:j + m] += filt(noise(m, seed * 13 + k), "bp", (1800, 4800)) * np.hanning(m)
    return x * g * 0.8


def fx_stamp(g):
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    f = 60 + 90 * np.exp(-t / 0.02)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.06, 0.001)
    return (body + filt(noise(n, 14), "bp", (300, 2000)) * env_exp(n, 0.015) * 0.4) * g


def fx_whoosh(g, seed, up=False, dur=0.7):
    x = noise_sweep(dur, 350 if not up else 250, 2600 if not up else 4200, seed, width=1.3, shape="arc")
    pan_l = np.linspace(-0.7, 0.7, len(x))
    p = (pan_l + 1) * np.pi / 4
    return np.stack([x * np.cos(p), x * np.sin(p)], 1) * g


def fx_riser(g, dur, seed):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    nz = sweep_bp(noise(n, seed), 250 * (40 ** t), width=1.0) * t ** 2
    tone = saw(midi_hz(50 + 24 * t ** 1.3), n) * t ** 2.2 * 0.18
    tone = filt(tone, "lp", 5000)
    y = fade(nz * 0.9 + tone, 0.01, 0.004)
    return y * g


def fx_suck(g, dur=0.6):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    x = filt(noise(n, 17), "bp", (500, 6000)) * t ** 3
    return fade(x * g, 0.01, 0.003)


def fx_counter(g, dur, seed):
    out = np.zeros(int((dur + 0.05) * SR))
    t, k = 0.0, 0
    while t < dur:
        rate = 12 + 38 * (t / dur) ** 1.5
        tk = fx_tick(0.5, 1800 + 900 * t / dur)
        j = int(t * SR)
        m = min(len(tk), len(out) - j)
        out[j:j + m] += tk[:m]
        t += 1.0 / rate
        k += 1
    return out * g


def fx_typing(g, dur, seed):
    r = rng(seed)
    out = np.zeros(int((dur + 0.08) * SR))
    t = 0.0
    while t < dur:
        n = int(0.03 * SR)
        k = filt(noise(n, int(t * 1000) + seed), "bp", (1200, 4200)) * env_exp(n, 0.004, 0.0004) * r.uniform(0.5, 1.0)
        j = int(t * SR)
        out[j:j + n] += k[:max(0, min(n, len(out) - j))]
        t += r.uniform(0.045, 0.085)
    return out * g


def fx_upload(g, dur):
    """Data chatter: soft 32nd-note grains that rise in pitch as the parts go up."""
    r = rng(23)
    out = np.zeros(int((dur + 0.05) * SR))
    for k, t in enumerate(times(0, dur, BEAT / 8)):
        p = t / dur
        n = int(0.018 * SR)
        f = 1400 + 1600 * p + r.uniform(-120, 120)
        grain = sine(f, n) * env_exp(n, 0.004, 0.0006) * (0.6 if k % 2 else 1.0)
        j = int(t * SR)
        out[j:j + n] += grain[:max(0, min(n, len(out) - j))] * min(1.0, (t + 0.05) / 0.25) * min(1.0, (dur - t) / 0.2 + 0.05)
    return out * g * 0.55


def overlay(*sigs):
    out = np.zeros(max(len(x) for x in sigs))
    for x in sigs:
        out[:len(x)] += x
    return out


def fx_note(g, step):
    m = [65, 67, 69, 72, 74, 77, 79][step]  # F4 G4 A4 C5 D5 F5 G5
    return overlay(bell(m + 12, 0.9, index=1.6, ratio=2.0, gain=0.9), pluck(m + 12, 0.18, 3000, seed=step) * 0.35) * g


def fx_done(g):
    a = bell(81, 0.9, 1.4, 2.0)
    b = np.concatenate([np.zeros(int(0.09 * SR)), bell(86, 1.1, 1.4, 2.0)])
    out = np.zeros(max(len(a), len(b)))
    out[:len(a)] += a
    out[:len(b)] += b
    return out * g * 0.8


def fx_shimmer(g):
    out = np.zeros(int(1.6 * SR))
    for k, m in enumerate([84, 88, 91, 93, 96]):
        b = bell(m, 1.0, 1.2, 3.0, 0.5)
        j = int(k * 0.06 * SR)
        out[j:j + len(b)] += b[:len(out) - j]
    return out * g


def fx_confirm(g, i):
    return fx_blip(g, 900 + 60 * i, 1500 + 90 * i)


FX_GAIN = 0.5
for c in CUES:
    t, ty, g = c["t"], c["type"], c["gain"] * FX_GAIN
    if ty == "hit_soft":
        x = fx_hit(0.7 * g)
        sfx.add(x, t)
        verb_send.add(x, t, 0.35)
    elif ty == "hit":
        x = fx_hit(1.0 * g, big=True)
        sfx.add(x, t)
        verb_send.add(x, t, 0.4)
    elif ty == "impact":
        x = fx_impact(1.25 * g)
        sfx.add(x, t)
        verb_send.add(x, t, 0.5)
    elif ty in ("whoosh", "whoosh_up"):
        x = fx_whoosh(0.55 * g, int(t * 10), up=ty == "whoosh_up")
        sfx.add(x, t - 0.25)
        verb_send.add(x, t - 0.25, 0.2)
    elif ty == "swish":
        x = fx_whoosh(0.35 * g, int(t * 10) + 1, up=True, dur=0.35)
        sfx.add(x, t - 0.1)
    elif ty == "cut":
        x = fx_whoosh(0.22 * g, int(t * 10) + 2, dur=0.45)
        sfx.add(x, t - 0.22)
    elif ty == "riser":
        x = fx_riser(0.5 * g, c.get("dur", 1.7), int(t))
        sfx.add(x, t)
        verb_send.add(x, t, 0.25)
    elif ty == "suck":
        sfx.add(fx_suck(0.45 * g), t - 0.45)
    elif ty == "print":
        sfx.add(fx_print(0.6 * g, int(t * 10)), t, pan=-0.1)
    elif ty == "stamp":
        sfx.add(fx_stamp(0.8 * g), t, pan=0.1)
    elif ty == "counter":
        sfx.add(fx_counter(0.35 * g, c.get("dur", 1.5), int(t)), t)
    elif ty == "tick":
        sfx.add(fx_tick(0.45 * g, 2300), t)
    elif ty == "click":
        sfx.add(fx_click(0.9 * g), t)
    elif ty == "drop":
        x = fx_stamp(0.9 * g)
        sfx.add(x, t)
        verb_send.add(x, t, 0.2)
    elif ty == "blip":
        sfx.add(fx_blip(0.35 * g), t)
    elif ty == "pop":
        sfx.add(fx_pop(0.6 * g), t)
    elif ty == "bubble":
        sfx.add(fx_pop(0.45 * g, 820 + 140 * c.get("i", 0), 300), t, pan=[-0.3, 0, 0.3][c.get("i", 0) % 3])
    elif ty == "typing":
        sfx.add(fx_typing(0.55 * g, c.get("dur", 1.0), int(t * 10)), t)
    elif ty == "enter":
        x = fx_stamp(0.55 * g)
        sfx.add(x + 0, t)
    elif ty == "confirm":
        sfx.add(fx_confirm(0.3 * g, c.get("i", 0)), t)
    elif ty == "done":
        x = fx_done(0.55 * g)
        sfx.add(x, t)
        verb_send.add(x, t, 0.4)
    elif ty == "note":
        x = fx_note(0.4 * g, c.get("step", 0))
        sfx.add(x, t, pan=-0.4 + 0.13 * c.get("step", 0))
        verb_send.add(x, t, 0.35)
    elif ty == "upload":
        sfx.add(fx_upload(0.35 * g, c.get("dur", 1.7)), t)
    elif ty == "shimmer":
        x = fx_shimmer(0.35 * g)
        sfx.add(x, t)
        verb_send.add(x, t, 0.6)
    elif ty == "sparkle":
        pass  # scored above, on the grid

# ── mix ─────────────────────────────────────────────────────────────────────
duck = sidechain([k for k in KICKS if k >= 10])
duck2 = duck[:, None]
music = pads.x * duck2 + bass.x * (0.35 + 0.65 * duck2) + arps.x * (0.5 + 0.5 * duck2) + bells.x
verb_send.x += pads.x * 0.22 + bells.x * 0.3
ir = make_ir()
wet = reverb(verb_send.x, ir) * 0.32

mix = music + drums.x * 0.78 + sfx.x + wet

# hard gaps before each drop: only the risers, the suck and the reverb tails survive
for a, b in SILENT:
    i, j = int(a * SR), int(b * SR)
    ramp = int(0.012 * SR)
    g = np.ones(N)
    g[i:j] = 0.0
    g[i - ramp:i] = np.linspace(1, 0, ramp)
    g[j:j + ramp] = np.linspace(0, 1, ramp)
    keep = sfx.x * (1 - g[:, None])
    mix = mix * g[:, None] + keep * 0.9 + wet * (1 - g[:, None]) * 0.6

# tail fade, gentle bus glue, soft clip
fade_out = np.clip((DUR - tt) / 0.9, 0, 1) ** 1.5
mix *= fade_out[:, None]
mix = filt(mix, "hp", 28)
mix = np.tanh(mix * 1.15) / 1.15
peak = np.abs(mix).max()
mix = mix / peak * 10 ** (-3 / 20)

out = os.path.join(HERE, "soundtrack-raw.wav")
pcm = np.clip(mix, -1, 1)
pcm = (pcm * 32767).astype("<i2")
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
stems = {"pads": pads.x * duck2, "bass": bass.x, "arps": arps.x, "bells": bells.x, "drums": drums.x * 0.78, "sfx": sfx.x, "reverb": wet}
stem_dir = os.environ.get("HOVOD_STEMS")
if stem_dir:
    os.makedirs(stem_dir, exist_ok=True)
    for k, v in stems.items():
        with wave.open(os.path.join(stem_dir, k + ".wav"), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(v / peak * 10 ** (-3 / 20), -1, 1) * 32767).astype("<i2").tobytes())
for k, v in stems.items():
    print(f"{k:7s} rms {20 * np.log10(np.sqrt((v ** 2).mean()) + 1e-12):6.1f} dBFS  peak {20 * np.log10(np.abs(v).max() + 1e-12):6.1f}", file=sys.stderr)
print(out)
