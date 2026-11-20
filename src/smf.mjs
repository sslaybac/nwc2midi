// Minimal Standard MIDI File (format 1) writer.

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n) => [(n >>> 8) & 0xff, n & 0xff];
const text = (s) => Array.from(Buffer.from(String(s), 'latin1'));

// Sort order for events on the same tick: setup first, then note-offs, then note-ons.
const ORDER = { meta: 0, program: 1, control: 2, bend: 3, off: 4, on: 5 };

export class Track {
  constructor(name) {
    this.events = [];
    if (name) this.meta(0, 0x03, text(name));
  }
  meta(tick, type, data) { this.events.push({ tick, kind: 'meta', bytes: [0xff, type, ...vlq(data.length), ...data] }); }
  tempo(tick, bpm) { this.meta(tick, 0x51, u32(Math.round(60_000_000 / bpm)).slice(1)); }
  timeSig(tick, num, den) { this.meta(tick, 0x58, [num, Math.log2(den), 24, 8]); }
  program(tick, ch, prog) { this.events.push({ tick, kind: 'program', bytes: [0xc0 | ch, prog & 0x7f] }); }
  control(tick, ch, cc, val) { this.events.push({ tick, kind: 'control', bytes: [0xb0 | ch, cc, clamp(val, 0, 127)] }); }
  bend(tick, ch, val) { val = clamp(val, 0, 16383); this.events.push({ tick, kind: 'bend', bytes: [0xe0 | ch, val & 0x7f, val >> 7] }); }
  note(start, end, ch, pitch, vel) {
    if (pitch < 0 || pitch > 127 || end <= start) return false;
    this.events.push({ tick: start, kind: 'on', bytes: [0x90 | ch, pitch, clamp(vel, 1, 127)] });
    this.events.push({ tick: end, kind: 'off', bytes: [0x80 | ch, pitch, 0] });
    return true;
  }
  get noteCount() { return this.events.filter((e) => e.kind === 'on').length; }
  encode() {
    const ev = this.events
      .map((e, i) => ({ ...e, i }))
      .sort((a, b) => a.tick - b.tick || ORDER[a.kind] - ORDER[b.kind] || a.i - b.i);
    const out = [];
    let t = 0;
    for (const e of ev) { out.push(...vlq(e.tick - t), ...e.bytes); t = e.tick; }
    out.push(0, 0xff, 0x2f, 0); // end of track
    return [...text('MTrk'), ...u32(out.length), ...out];
  }
}

export function encodeSMF(tracks, ppq) {
  const bytes = [...text('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(ppq)];
  for (const t of tracks) bytes.push(...t.encode());
  return Uint8Array.from(bytes);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }
