#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Wender
# SPDX-License-Identifier: GPL-2.0-or-later
"""Synthesizes the bundled drop sounds into sounds/.

A water drop "plip" is a short sine whose pitch rises quickly while it
decays. Hiding plays three of them, one per drop; showing plays a single
lower one that rises further, like the drops merging back.
"""

import math
import struct
import wave
from pathlib import Path

RATE = 44100


def plip(f0, f1, length, decay):
    n = int(RATE * length)
    out = []
    phase = 0.0
    for i in range(n):
        t = i / RATE
        freq = f0 * (f1 / f0) ** min(1.0, t / (length * 0.45))
        phase += 2 * math.pi * freq / RATE
        attack = min(1.0, t / 0.002)
        out.append(math.sin(phase) * attack * math.exp(-t / decay))
    return out


def mix(parts, total):
    buf = [0.0] * int(RATE * total)
    for start, samples, gain in parts:
        offset = int(RATE * start)
        for i, s in enumerate(samples):
            if offset + i < len(buf):
                buf[offset + i] += s * gain
    return buf


def write(path, samples, peak=0.45):
    top = max(abs(s) for s in samples) or 1.0
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(
            struct.pack('<h', int(s / top * peak * 32767)) for s in samples))


def main():
    out = Path(__file__).resolve().parent.parent / 'sounds'
    out.mkdir(exist_ok=True)

    write(out / 'drop-hide.wav', mix([
        (0.000, plip(820, 1900, 0.09, 0.030), 1.0),
        (0.045, plip(980, 2300, 0.08, 0.026), 0.8),
        (0.095, plip(900, 2100, 0.08, 0.024), 0.65),
    ], 0.22))

    write(out / 'drop-show.wav', mix([
        (0.000, plip(420, 1500, 0.14, 0.045), 1.0),
    ], 0.18))


if __name__ == '__main__':
    main()
