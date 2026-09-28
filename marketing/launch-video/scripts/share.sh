#!/usr/bin/env bash
# Two-pass H.264 copies of the masters that fit under a 30 MiB upload cap (about 3.4 Mb/s,
# SSIM ≈ 0.999 against the CRF 14 masters). Usage: scripts/share.sh [en fr ...]
set -euo pipefail
cd "$(dirname "$0")/../renders"
for L in "${@:-en fr}"; do
  for L1 in $L; do
    IN="hovod-launch-$L1.mp4"; OUT="hovod-launch-$L1-share.mp4"; LOG="$(mktemp -u)"
    ffmpeg -v error -y -i "$IN" -c:v libx264 -preset slow -b:v 3400k -maxrate 7M -bufsize 14M -pass 1 -passlogfile "$LOG" -an -f null /dev/null
    ffmpeg -v error -y -i "$IN" -c:v libx264 -preset slow -b:v 3400k -maxrate 7M -bufsize 14M -pass 2 -passlogfile "$LOG" -pix_fmt yuv420p -c:a copy -movflags +faststart "$OUT"
    rm -f "$LOG"*
    ffmpeg -v error -y -ss 13.8 -i "$IN" -frames:v 1 -q:v 2 "hovod-launch-$L1-poster.jpg"
    ls -la "$OUT"
  done
done
