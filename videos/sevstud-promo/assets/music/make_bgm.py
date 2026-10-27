"""The promo's music, synthesized from scratch: 124 BPM house in A minor, 16 bars plus a ringing tail.
No samples and no licence: every sound below is made from sine, saw and noise.
    python make_bgm.py   ->  bgm.wav next to this file (then ffmpeg makes bgm.m4a)

Bars 1-2 intro (filtered chords, riser) · 3 drop · 3-12 groove (arp from bar 7) · 13-14 lift with a snare roll
· 15 second drop for the call to action · 16 last hit and tail. A bar is 1.935 s; the video cuts on bar lines."""
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
BPM = 124
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 16
TAIL = 1.05
N = int((BARS * BAR + TAIL) * SR)
rng = np.random.default_rng(7)   # fixed: the same track every run

def note(name):
    names = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3, "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave - 4)) / 12)

CHORDS = [  # one a bar: Am  F  C  G
    (["A3", "C4", "E4", "A4"], "A1"), (["F3", "A3", "C4", "F4"], "F1"),
    (["G3", "C4", "E4", "G4"], "C2"), (["G3", "B3", "D4", "G4"], "G1"),
]

def lp(x, hz, order=2):
    return sosfilt(butter(order, min(hz, SR / 2 - 100), "low", fs=SR, output="sos"), x)

def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, "high", fs=SR, output="sos"), x)

def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], "band", fs=SR, output="sos"), x)

def saw(freq, t):
    return 2 * ((freq * t) % 1.0) - 1

def place(bus, sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(bus):
        return
    sig = sig[: len(bus) - i]
    bus[i:i + len(sig)] += gain * sig

def env(n, attack, decay_rate):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(attack, 1e-4)) * np.exp(-t * decay_rate)

# ---------- drums ----------
def kick():
    t = np.arange(int(0.45 * SR)) / SR
    freq = 46 + 120 * np.exp(-t * 32)
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 6.5)
    click = hp(rng.standard_normal(len(t)), 2500) * np.exp(-t * 300) * 0.25
    return np.tanh(1.6 * (body + click))

def clap():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 900, 2600)
    shape = np.zeros(n)
    for off in (0, 0.011, 0.022):
        shape += np.where(t >= off, np.exp(-(t - off) * 90), 0)
    shape += np.where(t >= 0.03, np.exp(-(t - 0.03) * 16) * 0.6, 0)
    return noise * shape * 0.9

def hat(open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7500, 4) * np.exp(-t * (14 if open_ else 70))

def snare():
    n = int(0.2 * SR)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    return (bp(rng.standard_normal(n), 1500, 6000) * np.exp(-t * 22) + 0.5 * tone)

K, CL, HC, HO, SN = kick(), clap(), hat(), hat(True), snare()

drums = np.zeros(N)
kick_times = []
for bar in range(BARS):
    t0 = bar * BAR
    full = 2 <= bar <= 11 or bar >= 14            # the groove; bars 1-2 and 13-14 build up
    for beat in range(4):
        tb = t0 + beat * BEAT
        if full or (bar < 2 and beat in (0, 2)) or (bar == 12):
            place(drums, K, tb, 1.0 if full else 0.7)
            kick_times.append(tb)
        if full and beat in (1, 3):
            place(drums, CL, tb, 0.55)
        if full or bar in (1, 12):
            place(drums, HO, tb + BEAT / 2, 0.16)
            for s in (0.25, 0.75):
                place(drums, HC, tb + s * BEAT, 0.07)
# the lift into the second drop: a snare roll speeding up across bar 14
roll = 13 * BAR
for i in range(16):
    place(drums, SN, roll + i * BEAT / 4, 0.12 + 0.03 * i)
for i in range(8):
    place(drums, SN, roll + 3 * BEAT + i * BEAT / 8, 0.5)

# ---------- sidechain: everything melodic ducks under the kick ----------
duck = np.ones(N)
for kt in kick_times:
    i = int(kt * SR)
    n = min(int(BEAT * SR), N - i)
    t = np.arange(n) / SR
    duck[i:i + n] = np.minimum(duck[i:i + n], 1 - 0.75 * np.exp(-t * 9))

# ---------- bass: offbeat eighths on the root, a sub underneath ----------
bass = np.zeros(N)
for bar in range(BARS):
    if not (2 <= bar <= 11 or bar >= 14):
        continue
    root = note(CHORDS[bar % 4][1])
    for beat in range(4):
        start = bar * BAR + beat * BEAT + BEAT / 2
        n = int(BEAT / 2 * SR * 0.92)
        t = np.arange(n) / SR
        tone = lp(saw(root * 2, t) * 0.6 + np.sin(2 * np.pi * root * t), 700, 4)
        place(bass, tone * env(n, 0.004, 9), start, 0.55)

# ---------- chords: a detuned supersaw pad, filter opening over the intro ----------
pad = np.zeros(N)
for bar in range(BARS):
    notes = CHORDS[bar % 4][0]
    n = int(BAR * SR)
    t = np.arange(n) / SR
    chord = np.zeros(n)
    for name in notes:
        f = note(name)
        for det in (-0.012, -0.005, 0.0, 0.006, 0.013):
            chord += saw(f * (1 + det), t + rng.random() * 0.01)
    chord /= len(notes) * 5
    if bar < 2:                                       # intro: the filter opens from muffled to bright
        cut = 350 + (bar * BAR + t) / (2 * BAR) * 3200
        lo = lp(chord, 350)
        hi = lp(chord, 3600)
        mix = (cut - 350) / 3200
        chord = lo * (1 - mix) + hi * mix
    elif bar in (12, 13):                             # the lift: thinner, then rising
        chord = hp(lp(chord, 2500), 300 + (bar - 12) * 400)
    else:
        chord = lp(chord, 4200)
    chord *= np.minimum(1, t / 0.01) * np.minimum(1, (BAR - t) / 0.02)
    place(pad, chord, bar * BAR, 0.5)

# ---------- arp: sixteenth-note plucks over the chord, from bar 7 ----------
arp = np.zeros(N)
pattern = [0, 1, 2, 3, 2, 1, 2, 3]
for bar in range(6, BARS):
    if bar in (12, 13):
        continue
    tones = [note(x) * 2 for x in CHORDS[bar % 4][0]]
    for s in range(16):
        f = tones[pattern[s % 8]]
        n = int(BEAT / 4 * SR * 1.6)
        t = np.arange(n) / SR
        pl = lp(saw(f, t) * 0.5 + np.sign(np.sin(2 * np.pi * f * t)) * 0.3, 3200)
        place(arp, pl * env(n, 0.002, 18), bar * BAR + s * BEAT / 4, 0.18)
# a dotted-eighth echo on the arp
echo = np.zeros(N)
d = int(BEAT * 0.75 * SR)
echo[d:] += arp[:-d] * 0.35
echo[2 * d:] += arp[:-2 * d] * 0.15
arp = arp + lp(echo, 2400)

# ---------- risers and impacts ----------
fx = np.zeros(N)
def riser(start, length):
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    for k in range(8):                                # the band climbs in steps
        a, b = k * n // 8, (k + 1) * n // 8
        out[a:b] = bp(noise[a:b], 300 + k * 900, 1500 + k * 1500)
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1400 * (t / length) ** 2) / SR) * 0.25
    place(fx, (out + sweep) * (t / length) ** 2, start, 0.45)

def impact(at):
    n = int(1.8 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(30 + 50 * np.exp(-t * 6)) / SR) * np.exp(-t * 3)
    crash = hp(rng.standard_normal(n), 3000) * np.exp(-t * 2.4) * 0.35
    place(fx, boom * 0.8 + crash, at, 0.6)

riser(0.6, 2 * BAR - 0.6)
impact(2 * BAR)
riser(12 * BAR + BAR * 0.2, 2 * BAR - BAR * 0.2)
impact(14 * BAR)
impact(BARS * BAR)                                    # the last hit, ringing into the tail
last = np.zeros(int((TAIL + 0.6) * SR))
tt = np.arange(len(last)) / SR
for name in CHORDS[0][0]:
    last += lp(saw(note(name), tt), 2500)
place(pad, last / 4 * np.exp(-tt * 2.2), BARS * BAR, 0.6)

# ---------- reverb on the melodic bus, then the mix ----------
ir_n = int(1.1 * SR)
ir = rng.standard_normal(ir_n) * np.exp(-np.arange(ir_n) / SR * 4.5)
ir = lp(ir, 5000) / np.sqrt(np.sum(ir ** 2))
melodic = (pad + arp) * duck
wet = fftconvolve(melodic, ir)[:N] * 0.22

left = drums + bass * duck + melodic * 0.95 + wet + fx
right = drums + bass * duck + melodic * 0.95 + np.roll(wet, int(0.013 * SR)) + fx
# a little width: the arp leans right, the pad left
right += arp * duck * 0.08
left += pad * duck * 0.05
mix = np.stack([left, right], axis=1)
mix = hp(mix.T, 28).T
mix /= np.max(np.abs(mix))
mix = np.tanh(mix * 1.6) / np.tanh(1.6)               # gentle glue
fade = np.ones(N)
fade[: int(0.03 * SR)] = np.linspace(0, 1, int(0.03 * SR))
fade[-int(0.5 * SR):] = np.linspace(1, 0, int(0.5 * SR))
mix = mix * fade[:, None] * 0.89                      # about -1 dBFS

out = Path(__file__).with_name("bgm.wav")
wavfile.write(out, SR, (mix * 32767).astype(np.int16))
print(f"{out.name}: {N / SR:.2f} s, bar {BAR:.4f} s, {BARS} bars")
