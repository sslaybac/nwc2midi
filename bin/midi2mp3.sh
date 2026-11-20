#!/usr/bin/env bash
# midi2mp3: render a tree of MIDI files to MP3 with a SoundFont, mirroring folders.
#
#   midi2mp3.sh [--artist NAME] [--jobs N] <soundfont.sf2> <midi-dir> <mp3-dir>
#
# Each file is rendered by FluidSynth to 32-bit float WAV (no clipping), peak-
# normalised to -1 dBFS with SoX (trailing silence below -80 dB trimmed to 1 s),
# then encoded with LAME (VBR -V2). ID3 tags:
# title = file name, album = top-level folder, artist = --artist if given.
# Requires: fluidsynth, sox, lame.
set -euo pipefail

artist="" jobs=4
while [[ $# -gt 0 && $1 == --* ]]; do
  case $1 in
    --artist) artist=$2; shift 2 ;;
    --jobs) jobs=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [[ $# -ne 3 ]]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2
fi
sf=$(realpath "$1") src=$(realpath "$2") out=$(realpath -m "$3")
for t in fluidsynth sox lame; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
[[ -f $sf ]] || { echo "soundfont not found: $sf" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

render() {  # $1 = path relative to $src
  local rel=$1 stem=${1%.mid}
  local mp3="$out/$stem.mp3" key=${stem//\//_}
  local raw="$tmp/$key.raw.wav" wav="$tmp/$key.wav"
  local album=${rel%%/*}; [[ $album == "$rel" ]] && album=""
  mkdir -p "$(dirname "$mp3")"
  if fluidsynth -ni -q -g 1.0 -r 44100 -O float -T wav -F "$raw" "$sf" "$src/$rel" 2>/dev/null &&
     sox -V1 "$raw" -b 16 "$wav" reverse silence 1 0.05 -80d reverse gain -n -1 pad 0 1 dither &&
     lame --quiet -V2 --tt "$(basename "$stem")" ${album:+--tl "$album"} ${artist:+--ta "$artist"} \
       --tc "Rendered from $(basename "$rel") with $(basename "$sf")" "$wav" "$mp3"; then
    echo "OK   $rel"
  else
    echo "FAIL $rel"
  fi
  rm -f -- "$raw" "$wav"
}
export -f render
export sf src out tmp artist

cd "$src"
find . -type f -iname '*.mid' -printf '%P\0' | sort -z |
  xargs -0 -P "$jobs" -I{} bash -c 'render "$1"' _ {} | tee "$tmp/log"
fails=$(grep -c '^FAIL' "$tmp/log" || true)
echo "done: $(grep -c '^OK' "$tmp/log") rendered, $fails failed"
[[ $fails -eq 0 ]]
