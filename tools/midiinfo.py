"""Summarise a Standard MIDI File: per-channel programs and note counts, tempos, length."""
import sys
import struct


def vlq(d, i):
    v = 0
    while True:
        b = d[i]; i += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, i


def info(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'MThd'
    fmt, ntrk, div = struct.unpack('>HHH', d[8:14])
    i = 14
    chans = {}
    tempos = []
    events = []  # (tick, kind, value)
    for _ in range(ntrk):
        assert d[i:i + 4] == b'MTrk'
        ln = struct.unpack('>I', d[i + 4:i + 8])[0]
        j, end, tick, run = i + 8, i + 8 + ln, 0, 0
        while j < end:
            dt, j = vlq(d, j); tick += dt
            st = d[j]
            if st == 0xFF:
                typ = d[j + 1]; l, j = vlq(d, j + 2)
                if typ == 0x51:
                    tempos.append((tick, 60_000_000 / int.from_bytes(d[j:j + 3], 'big')))
                    events.append((tick, 'tempo', tempos[-1][1]))
                j += l; continue
            if st in (0xF0, 0xF7):
                l, j = vlq(d, j + 1); j += l; continue
            if st & 0x80:
                run = st; j += 1
            ch, kind = run & 0x0F, run & 0xF0
            c = chans.setdefault(ch + 1, {'programs': [], 'notes': 0, 'last': 0})
            if kind in (0xC0, 0xD0):
                if kind == 0xC0:
                    c['programs'].append(d[j] + 1)
                j += 1
            else:
                a, b = d[j], d[j + 1]; j += 2
                if kind == 0x90 and b > 0:
                    c['notes'] += 1
                c['last'] = max(c['last'], tick)
        i = end
    # length in seconds using tempo map
    last = max((c['last'] for c in chans.values()), default=0)
    tmap = sorted(tempos) or [(0, 120)]
    secs, prev_t, bpm = 0.0, 0, 120
    for t, b in tmap:
        if t > last:
            break
        secs += (t - prev_t) / div * 60 / bpm; prev_t, bpm = t, b
    secs += (last - prev_t) / div * 60 / bpm
    return fmt, ntrk, chans, tmap, secs


if __name__ == '__main__':
    for p in sys.argv[1:]:
        fmt, ntrk, chans, tmap, secs = info(p)
        print(f'{p.rsplit("/", 1)[-1]}: format {fmt}, {ntrk} tracks, {secs:.0f}s, tempos {[round(b) for _, b in tmap][:6]}')
        for ch in sorted(chans):
            c = chans[ch]
            print(f'   ch{ch:>2}: GM program(s) {sorted(set(c["programs"]))}, {c["notes"]} notes')
