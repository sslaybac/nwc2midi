// Convert a parsed NoteWorthy Composer score straight to a Standard MIDI File.
//
// Playback rules follow NoteWorthy's behaviour as far as it is known; where a
// rule is an assumption it is marked ASSUMPTION and listed in README.md.

import { parseNWC } from '../vendor/nwc2xml/index.js';
import { ObjType, NoteAttr, DurationType, BarStyle, GM_PATCHES } from '../vendor/nwc2xml/constants.js';
import { Track, encodeSMF } from './smf.mjs';

export const PPQ = 960;
const WHOLE = PPQ * 4;
const DEFAULT_TEMPO = 120;            // ASSUMPTION: no tempo mark plays at 120 BPM (also the MIDI default)
const DEFAULT_DYNAMIC = 4;            // ASSUMPTION: notes before any dynamic play at mf
const CLEF_SHIFT = [0, 12, 6, 8];     // treble, bass, alto, tenor: staff positions relative to treble
const STEP_SEMITONE = [9, 11, 0, 2, 4, 5, 7]; // A B C D E F G
const ACC_ALTER = [1, -1, 0, 2, -2];  // sharp, flat, natural, double sharp, double flat
const MPC = { TEMPO: 0, VOLUME: 1, PITCH_BEND: 4 };

/** Duration in ticks of a note/rest/chord object (all share the same encoding). */
function ticksOf(obj) {
  let d = WHOLE / (1 << obj.getDuration());
  const dt = obj.getDurationType();
  if (dt & DurationType.DotDot) d *= 1.75;
  else if (dt & DurationType.Dot) d *= 1.5;
  if (dt & DurationType.Triplet) d = (d * 2) / 3;
  return Math.round(d);
}

function tempoToQuarterBpm(t) {
  const unit = [0.5, 1, 2][Math.floor(t.base / 2)] ?? 1; // eighth, quarter, half
  return t.value * unit * (t.base % 2 ? 1.5 : 1);
}

/** Expand repeat barlines into a flat playback order of objects. */
function unroll(objects, warn) {
  const out = [];
  const passes = new Map();
  let openIdx = 0;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    out.push(o);
    if (o.type === ObjType.Ending || o.type === ObjType.FlowDir) warn(`${o.type === ObjType.Ending ? 'ending' : 'flow direction (D.C./D.S./coda)'} not supported; played straight through`);
    if (o.type !== ObjType.BarLine) continue;
    const style = o.getStyle();
    if (style === BarStyle.LocalOpen || style === BarStyle.MasterOpen) openIdx = i + 1;
    if (style === BarStyle.LocalClose || style === BarStyle.MasterClose) {
      const times = style === BarStyle.LocalClose ? Math.max(o.repeatCount, 2) : 2;
      const done = passes.get(i) ?? 1;
      if (done < times) { passes.set(i, done + 1); i = openIdx - 1; }
      else passes.delete(i);
    }
  }
  return out;
}

/**
 * Convert NWC file bytes to MIDI.
 * @param {Uint8Array} bytes
 * @param {{includeMuted?: boolean, title?: string}} opts
 */
export function convert(bytes, opts = {}) {
  const file = parseNWC(bytes);
  const warnings = new Set();
  const tempos = [];   // [tick, bpm, staffIndex]
  const timeSigs = []; // [tick, num, den] from the first staff that has any
  const tracks = [];
  const report = [];
  let endTick = 0;

  file.staffs.forEach((staff, si) => {
    const warn = (m) => warnings.add(`staff ${si + 1} "${staff.name}": ${m}`);
    const ch = staff.channel & 0x0f;
    const info = {
      name: staff.name, channel: ch + 1, muted: staff.muted,
      instrument: staff.patchUnset ? '(not set)' : `${staff.patchName + 1} ${GM_PATCHES[staff.patchName]}`,
      notes: 0, programChanges: 0, controllers: 0,
    };
    report.push(info);
    const skipNotes = staff.muted && !opts.includeMuted;
    const track = new Track(staff.name + (skipNotes ? ' (muted in NWC)' : ''));

    if (!skipNotes) {
      if (!staff.patchUnset) track.program(0, ch, staff.patchName);
      track.control(0, ch, 7, Math.min(staff.volume ?? 127, 127));
      track.control(0, ch, 10, Math.min(staff.pan ?? 64, 127));
    }

    let t = 0;
    let clefShift = 0, octave = 0;
    let keyAlter = new Array(7).fill(0);
    let barAlter = new Map();            // letter (0-6) -> alter, reset at barlines
    let barTicks = WHOLE;
    let velocities = staff.dynamicVelocity ?? [10, 30, 45, 60, 75, 92, 108, 127];
    let dynamic = DEFAULT_DYNAMIC;
    const pending = new Map();           // midi pitch -> sounding (possibly tied) note
    const tiedAlter = new Map();         // "step:octave" -> alter carried by an open tie

    const flush = (pitch) => {
      const n = pending.get(pitch);
      if (!n) return;
      pending.delete(pitch);
      if (!skipNotes && track.note(n.start, n.end, ch, pitch, n.vel)) info.notes++;
      endTick = Math.max(endTick, n.end);
    };

    const playNote = (note, dur) => {
      const attrs = note.getAttributes();
      const p = clefShift + note.pos;
      const oct = Math.floor((4 * 7 - p + 6) / 7);
      const step = ((4 * 7 - p + 1) % 7 + 7) % 7;
      const key = `${step}:${oct}`;
      const acc = note.getAccidental();
      let alter;
      // NoteWorthy plays an accidental for the rest of the bar on every note
      // of that letter name, in all octaves (unlike engraving convention).
      if (acc <= 4) { alter = ACC_ALTER[acc]; barAlter.set(step, alter); }
      else if (tiedAlter.has(key)) alter = tiedAlter.get(key);
      else if (barAlter.has(step)) alter = barAlter.get(step);
      else alter = keyAlter[step];
      const pitch = 12 * (oct + 1) + STEP_SEMITONE[step] + alter + octave + (staff.transposition || 0);

      const grace = attrs & NoteAttr.Grace;
      const len = grace ? WHOLE / 32 : dur;
      let sound = len;
      if (attrs & NoteAttr.Staccatissimo) sound = len / 4;
      else if (attrs & NoteAttr.Staccato) sound = len / 2;

      const prev = pending.get(pitch);
      if (prev && prev.tied && prev.fullEnd === t) {
        prev.end = t + sound; prev.fullEnd = t + len; // continue the tie
      } else {
        flush(pitch);
        pending.set(pitch, { start: t, end: t + sound, fullEnd: t + len, vel: velocities[dynamic] ?? 75 });
      }
      const n = pending.get(pitch);
      n.tied = !!(attrs & NoteAttr.TieBeg);
      if (n.tied) { n.end = n.fullEnd; tiedAlter.set(key, alter); } else { tiedAlter.delete(key); flush(pitch); }
      return grace ? 0 : dur;
    };

    for (const o of unroll(staff.objects, warn)) {
      switch (o.type) {
        case ObjType.Clef:
          if (o.clefType > 3) warn(`clef type ${o.clefType} treated as treble`);
          clefShift = CLEF_SHIFT[o.clefType] ?? 0;
          octave = o.octaveShift === 1 ? 12 : o.octaveShift === 2 ? -12 : 0; // ASSUMPTION: 1 = 8va, 2 = 8vb
          break;
        case ObjType.KeySig:
          keyAlter = o.getChromAlter();
          barAlter = new Map();
          break;
        case ObjType.TimeSig:
          barTicks = (o.beats * WHOLE) / o.getBeatType();
          if (si === 0 || timeSigs.owner === si || timeSigs.length === 0) {
            timeSigs.owner = si;
            timeSigs.push([t, o.beats, o.getBeatType()]);
          }
          break;
        case ObjType.BarLine:
          barAlter = new Map();
          break;
        case ObjType.Tempo:
          tempos.push([t, tempoToQuarterBpm(o), si]);
          break;
        case ObjType.Dynamic:
          dynamic = o.style & 0x07;
          break;
        case ObjType.Instrument:
          if (o.dynamicVelocity) velocities = o.dynamicVelocity;
          if (!o.patchUnset && !skipNotes) { track.program(t, ch, o.patch); info.programChanges++; }
          break;
        case ObjType.Pedal:
          if (!skipNotes) track.control(t, ch, 64, o.style ? 127 : 0); // 1 = pedal down, 0 = release
          break;
        case ObjType.MPC:
          info.controllers += mpcEvents(o, t, (tick, v) => {
            if (o.controller === MPC.TEMPO) tempos.push([tick, v, si]);
            else if (skipNotes) return;
            else if (o.controller === MPC.VOLUME) track.control(tick, ch, 7, v);
            else if (o.controller === MPC.PITCH_BEND) track.bend(tick, ch, v);
          }, warn);
          break;
        case ObjType.Note:
          t += playNote(o, ticksOf(o));
          break;
        case ObjType.NoteCM: {
          const notes = o.children.filter((c) => c.type === ObjType.Note);
          const durs = notes.map(ticksOf);
          const start = t;
          notes.forEach((n, k) => { t = start; playNote(n, durs[k]); });
          const graceOnly = notes.every((n) => n.getAttributes() & NoteAttr.Grace);
          t = start + (graceOnly ? 0 : Math.min(ticksOf(o), ...durs));
          break;
        }
        case ObjType.Rest:
        case ObjType.RestCM: {
          const start = t;
          const restLen = o.getDuration() === 0 ? barTicks : ticksOf(o); // whole rest fills the bar
          for (const c of o.children ?? []) if (c.type === ObjType.Note) { t = start; playNote(c, ticksOf(c)); }
          t = start + restLen;
          break;
        }
        case ObjType.TempVar:
        case ObjType.DynVar:
        case ObjType.Perform:
          warn(`${{ [ObjType.TempVar]: 'tempo variation (fermata/rit./accel.)', [ObjType.DynVar]: 'dynamic variation (cresc./dim.)', [ObjType.Perform]: 'performance style' }[o.type]} ignored`);
          break;
      }
    }
    for (const p of [...pending.keys()]) flush(p);
    endTick = Math.max(endTick, t);
    tracks.push(track);
  });

  // Conductor track: title, tempo map, time signatures
  const conductor = new Track(opts.title || file.title || '');
  const byTick = new Map();
  for (const [tick, bpm, si] of tempos) {
    const cur = byTick.get(tick);
    if (!cur || si < cur.si) byTick.set(tick, { bpm, si }); // ties: first staff wins
  }
  if (!byTick.has(0)) byTick.set(0, { bpm: DEFAULT_TEMPO, si: -1 });
  for (const [tick, { bpm }] of [...byTick].sort((a, b) => a[0] - b[0])) conductor.tempo(tick, bpm);
  for (const [tick, num, den] of timeSigs) conductor.timeSig(tick, num, den);

  return {
    midi: encodeSMF([conductor, ...tracks], PPQ),
    version: file.version,
    staves: report,
    warnings: [...warnings],
    endTick,
    tempoMap: [...byTick].sort((a, b) => a[0] - b[0]).map(([tick, { bpm }]) => [tick, bpm]),
  };
}

/** Emit the value changes of a multi-point controller. Returns events emitted. */
function mpcEvents(o, t, emit, warn) {
  if (![MPC.TEMPO, MPC.VOLUME, MPC.PITCH_BEND].includes(o.controller)) {
    warn(`multi-point controller type ${o.controller} not supported`);
    return 0;
  }
  if (!o.points?.length) return 0;
  const unit = WHOLE / (1 << o.timeRes);
  let n = 0, at = t;
  const pts = o.points.map((p) => ({ tick: (at += p.delta * unit), value: p.value }));
  emit(pts[0].tick, pts[0].value); n++;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (o.style === 1 && b.tick > a.tick) {
      const step = Math.max(1, Math.round(unit / Math.max(o.sweepRes, 16)));
      for (let k = a.tick + step; k < b.tick; k += step) {
        emit(k, Math.round(a.value + ((b.value - a.value) * (k - a.tick)) / (b.tick - a.tick))); n++;
      }
    }
    emit(b.tick, b.value); n++;
  }
  return n;
}
