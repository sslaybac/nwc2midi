#!/usr/bin/env node
// nwc2midi: convert NoteWorthy Composer (.nwc) files to Standard MIDI Files.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, basename, extname } from 'path';
import { convert } from '../src/nwc2midi.mjs';

const USAGE = `Usage:
  nwc2midi [options] <input.nwc> [output.mid]
  nwc2midi [options] --tree <source-dir> <output-dir>

Options:
  --tree           Convert every .nwc file under <source-dir>, mirroring the
                   folder structure under <output-dir>.
  --include-bak    With --tree, also convert NoteWorthy .BAK backups,
                   written as "<name> (backup).mid".
  --include-muted  Play staves that are muted in NoteWorthy (default: they
                   keep their track but contain no notes).
  --quiet          Only print errors and warnings.
  -h, --help       Show this help.`;

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
if (flag('-h') || flag('--help') || args.length === 0) { console.log(USAGE); process.exit(args.length ? 0 : 1); }
const tree = flag('--tree'), includeBak = flag('--include-bak'), includeMuted = flag('--include-muted'), quiet = flag('--quiet');
const unknown = args.filter((a) => a.startsWith('--'));
if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n\n${USAGE}`); process.exit(2); }

function convertOne(src, dst) {
  const title = basename(src).replace(/\.(nwc|bak)$/i, '');
  const r = convert(readFileSync(src), { includeMuted, title });
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, r.midi);
  const notes = r.staves.reduce((n, s) => n + s.notes, 0);
  const muted = r.staves.filter((s) => s.muted).length;
  if (!quiet) console.log(`OK   ${src} -> ${dst}  (v${(r.version >> 8)}.${(r.version & 0xff).toString().padStart(2, '0')}, ${r.staves.length} staves${muted ? `, ${muted} muted` : ''}, ${notes} notes)`);
  for (const w of r.warnings) console.log(`     warning: ${w}`);
}

let failures = 0;
const attempt = (src, dst) => {
  try { convertOne(src, dst); } catch (e) { failures++; console.error(`FAIL ${src}: ${e.message}`); }
};

if (tree) {
  if (args.length !== 2) { console.error(USAGE); process.exit(2); }
  const [srcRoot, outRoot] = args;
  const walk = (d) => readdirSync(d).sort().flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const src of walk(srcRoot)) {
    const ext = extname(src).toLowerCase();
    if (ext !== '.nwc' && !(includeBak && ext === '.bak')) continue;
    const rel = relative(srcRoot, src);
    const stem = rel.slice(0, -ext.length);
    attempt(src, join(outRoot, ext === '.bak' ? `${stem} (backup).mid` : `${stem}.mid`));
  }
} else {
  if (args.length < 1 || args.length > 2) { console.error(USAGE); process.exit(2); }
  attempt(args[0], args[1] ?? args[0].replace(/\.(nwc|bak)$/i, '') + '.mid');
}
process.exit(failures ? 1 : 0);
