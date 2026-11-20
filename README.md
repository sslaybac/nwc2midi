# nwc2midi

Converts NoteWorthy Composer `.nwc` files (binary formats 1.x and 2.0x) straight
to Standard MIDI Files, with no NoteWorthy, Wine or MuseScore involved.

It was built for a collection of NWC 1.75 and 2.02 songs that the existing free
tools could not convert faithfully (see *Why not an existing tool* below).

## Requirements

Node.js 18 or newer. No npm dependencies.

## Usage

```sh
# one file (writes song.mid next to it unless an output path is given)
node bin/nwc2midi.mjs song.nwc [out.mid]

# a whole folder tree, mirrored into an output folder
node bin/nwc2midi.mjs --tree <source-dir> <output-dir>
```

Options:

| Option | Effect |
|---|---|
| `--tree` | Convert every `.nwc` under the source folder, mirroring its folder structure. |
| `--include-bak` | With `--tree`, also convert NoteWorthy `.BAK` backups, written as `<name> (backup).mid`. |
| `--include-muted` | Play staves that are muted in NoteWorthy. By default they keep their track but contain no notes. |
| `--quiet` | Only print errors and warnings. |

Each file prints a summary line (format version, staves, muted staves, notes) and
any warnings about notation that could not be played back.

### Rendering MIDI to MP3

```sh
bin/midi2mp3.sh [--artist NAME] [--jobs N] <soundfont.sf2> <midi-dir> <mp3-dir>
```

This renders every `.mid` under `<midi-dir>` and mirrors the folders under
`<mp3-dir>`. Each file goes through these steps:

1. FluidSynth renders it to 32-bit float WAV at 44.1 kHz with gain 1.0, so
   nothing clips.
2. SoX trims trailing silence below −80 dB to 1 second and normalises the peak
   to −1 dBFS.
3. LAME encodes it as VBR `-V2`.

ID3 tags: the title is the file name, the album is the top-level folder, and the
artist is `--artist`. It requires `fluidsynth`, `sox` and `lame`.

Each FluidSynth process loads the whole SoundFont, so with a large SoundFont,
keep `--jobs` × SoundFont size within free memory.

## What is converted

- Notes, chords and rests, with dots, double dots and triplets; whole rests fill the bar.
- Treble, bass, alto and tenor clefs; key signatures; accidentals (see the rule below); ties, including across barlines.
- Staccato (half length) and staccatissimo (quarter length).
- Repeat barlines (local and master repeats, including repeat counts).
- Tempo marks, and tempo sweeps, as one global tempo map. A song with no tempo mark plays at 120 BPM.
- Each staff on its own track and channel, with:
  - its instrument (General MIDI patch);
  - mid-song instrument changes;
  - part volume (CC7) and pan (CC10);
  - transposition;
  - sustain pedal (CC64).
- Multi-point controllers: volume (CC7) and pitch bend, absolute or swept.
- Dynamics: velocity comes from the staff's dynamic velocity table, which 2.0x files store; 1.x files use NoteWorthy's default table.

Not supported (reported as warnings when present): endings (1st/2nd time bars),
D.C./D.S./coda/fine, tempo variations (fermata, rit., accel.), dynamic variations
(cresc./dim.), performance styles, and multi-point controllers other than tempo,
volume and pitch bend.

## Playback rules and assumptions

These follow NoteWorthy's own playback where it is known:

- **Accidentals** last for the rest of the bar on every note of the same letter
  name, *in all octaves*. That's NoteWorthy's playback behaviour, even though
  engraving convention limits an accidental to one octave.
- **Muted staves** are silent, as in NoteWorthy. Pass `--include-muted` to hear them.
- **Instrument numbers** in the binary format are 1-based, and 0 means "not set".
  For an unset staff no program change is sent, so the synth's default plays:
  piano, or drums on channel 10.

Assumptions (unverified; marked `ASSUMPTION` in the source):

- Notes before any dynamic mark play at *mf*.
- With no tempo mark, playback is 120 BPM.
- Clef octave shift values 1 and 2 mean 8va and 8vb. The collection this was
  built for uses no octave clefs.
- The layout of the multi-point controller object was inferred from real files:
  controller type, style, time and sweep resolution, then 4 points of
  (used, time delta, value). Types 0 (tempo), 1 (volume) and 4 (pitch bend) are
  confirmed by their values. Other types are skipped with a warning.

## Parser: vendored and patched

`vendor/nwc2xml/` is the NWC parser and MusicXML writer from
[zz85/nwc-viewer](https://github.com/zz85/nwc-viewer) (`lib/nwc2xml`, commit
`af5e65d58ab787d084205bb76d02860d3f3a0022`, 2026-10-13), GPL-2.0. The changes are
recorded in `vendor/nwc2xml.patch`, and each one is marked `[nwc2midi]` in the
source:

1. **Header counter byte.** Some files keep a small counter (0x02, 0x03, ...)
   between the version and the user string, where the parser expected only zero
   padding. The parser read it as the user name and shifted every header field
   by one, so all files of that kind failed to parse.
2. **1-based instrument numbers.** The parser treated the staff patch byte as
   0-based, so every instrument came out one GM program too high. It now
   normalises to 0-based and records `patchUnset`. This also fixes the MusicXML
   writer's instruments.
3. **Fields that were skipped are now kept:** staff instrument name, dynamic
   velocity table (2.0x), part volume and pan.
4. **Instrument change objects** now decode their patch, and in 2.0x their
   velocity table.
5. **Multi-point controller objects** are now decoded instead of skipped.

## Verification

`tools/` holds the checks used during development:

- `tools/midiinfo.py file.mid ...`: per-channel programs, note counts, tempos
  and length of a MIDI file.
- `tools/reference-xml.mjs <src-root> <out-root> <files...>`: writes the vendored
  MusicXML writer's output for each file.
- `tools/crosscheck.py <xml-root> <midi-root>`: compares the onset and pitch of
  every note against that MusicXML. The MusicXML writer computes pitch
  independently of this converter.

Expected differences are repeats (MusicXML doesn't unroll them) and staff
transposition (MusicXML doesn't apply it). On the original 84-file collection,
every other note matched.

## Why not an existing tool

- **NoteWorthy Composer under Wine:** `-convert` is only available in the
  registered version. The demo just opens its editor.
- **lasconic/nwc2musicxml:** reads only NWC 2.75+ files.
- **nwc-viewer's nwc2xml followed by MuseScore:** this route hit the parser
  bugs above. On top of that:
  - MuseScore re-maps instruments by name (for example Synth Bass 2 became
    Synth Bass 1);
  - it plays muted staves;
  - instrument changes, volume and pan, and controller sweeps are lost.

## License

GPL-2.0-only, inherited from the vendored nwc-viewer code (see `LICENSE`).
