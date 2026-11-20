"""Cross-check nwc2midi output against the vendored MusicXML writer.

For every staff, compare the (onset tick, MIDI pitch) of each sounded note.
Usage: crosscheck.py <xml-root> <midi-root>
"""
import os
import struct
import sys
import xml.etree.ElementTree as ET
from collections import Counter

PPQ = 960
STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def xml_notes(path):
    parts = []
    for p in ET.parse(path).getroot().findall('part'):
        div, t, last_start, out, ties = 1, 0, 0, [], {}
        for m in p.findall('measure'):
            for el in m:
                if el.tag == 'attributes' and el.find('divisions') is not None:
                    div = int(el.find('divisions').text)
                if el.tag in ('backup', 'forward'):
                    d = int(el.find('duration').text) * PPQ // div
                    t += -d if el.tag == 'backup' else d
                if el.tag != 'note':
                    continue
                dur = el.find('duration')
                d = int(dur.text) * PPQ // div if dur is not None else 0
                start = last_start if el.find('chord') is not None else t
                if el.find('chord') is None:
                    t += d
                last_start = start
                pitch = el.find('pitch')
                if pitch is None:
                    continue
                midi = 12 * (int(pitch.findtext('octave')) + 1) + STEP[pitch.findtext('step')] + int(float(pitch.findtext('alter') or 0))
                tie_start = any(x.get('type') == 'start' for x in el.findall('tie'))
                if ties.get(midi) == start:
                    pass  # continuation of a tie
                else:
                    out.append((start, midi))
                if tie_start:
                    ties[midi] = start + d
                else:
                    ties.pop(midi, None)
        parts.append(out)
    return parts


def vlq(d, i):
    v = 0
    while True:
        b = d[i]; i += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, i


def midi_tracks(path):
    d = open(path, 'rb').read()
    ntrk = struct.unpack('>H', d[10:12])[0]
    i, tracks = 14, []
    for _ in range(ntrk):
        ln = struct.unpack('>I', d[i + 4:i + 8])[0]
        j, end, tick, run, name, notes = i + 8, i + 8 + ln, 0, 0, '', []
        while j < end:
            dt, j = vlq(d, j); tick += dt
            if d[j] == 0xFF:
                typ = d[j + 1]; l, j = vlq(d, j + 2)
                if typ == 3:
                    name = d[j:j + l].decode('latin1')
                j += l; continue
            if d[j] & 0x80:
                run = d[j]; j += 1
            k = run & 0xF0
            if k in (0xC0, 0xD0):
                j += 1; continue
            if k == 0x90 and d[j + 1] > 0:
                notes.append((tick, d[j]))
            j += 2
        tracks.append((name, notes))
        i = end
    return tracks[1:]


def main(xml_root, midi_root):
    total = same = 0
    worst = []
    for dirpath, _, files in os.walk(xml_root):
        for f in files:
            xp = os.path.join(dirpath, f)
            mp = os.path.join(midi_root, os.path.relpath(xp, xml_root))[:-4] + '.mid'
            for si, (xn, (name, mn)) in enumerate(zip(xml_notes(xp), midi_tracks(mp))):
                if name.endswith('(muted in NWC)'):
                    continue
                a, b = Counter(xn), Counter(mn)
                common = sum((a & b).values())
                n = max(len(xn), len(mn))
                total += n; same += common
                if common < n:
                    worst.append((n - common, os.path.relpath(xp, xml_root), si + 1, name, len(xn), len(mn), sorted((a - b).elements())[:4], sorted((b - a).elements())[:4]))
    print(f'notes compared: {total}, identical onset+pitch: {same} ({100 * same / max(total, 1):.2f}%)')
    for w in sorted(worst, reverse=True)[:25]:
        print('  diff %4d  %s staff %d "%s": xml %d / midi %d  xml-only %s  midi-only %s' % w)


main(*sys.argv[1:])
