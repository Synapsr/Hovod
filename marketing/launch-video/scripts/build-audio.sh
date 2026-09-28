#!/usr/bin/env bash
# Rebuild the soundtrack from the timeline: cues -> synthesis -> loudness (-14 LUFS, -1.5 dBTP) -> AAC.
# Needs: a Chromium/Chrome binary (arg 1 or $HYPERFRAMES_BROWSER_PATH), python3 with numpy + scipy, ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
scripts/export-cues.sh "${1:-${HYPERFRAMES_BROWSER_PATH:-chromium}}" > audio/cues.json
"$PY" audio/soundtrack.py
# two-pass EBU R128 normalisation
STATS=$(ffmpeg -hide_banner -nostats -i audio/soundtrack-raw.wav -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { echo "$STATS" | sed -n "s/.*\"$1\" : \"\(.*\)\".*/\1/p"; }
ffmpeg -v error -y -i audio/soundtrack-raw.wav -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true,aresample=48000" -c:a pcm_s16le audio/soundtrack.wav
# the composition plays the AAC copy (small enough to live in git); the WAV stays local
ffmpeg -v error -y -i audio/soundtrack.wav -c:a aac -b:a 256k -movflags +faststart audio/soundtrack.m4a
ffmpeg -hide_banner -nostats -i audio/soundtrack.m4a -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tr -s ' '
