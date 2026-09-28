#!/usr/bin/env bash
# Print the sound cues recorded by src/film.js (JSON) by loading the composition in headless Chrome.
# Usage: scripts/export-cues.sh [chrome-binary] > audio/cues.json
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${1:-${HYPERFRAMES_BROWSER_PATH:-chromium}}"
"$CHROME" --headless --no-sandbox --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=10000 --dump-dom "file://$PWD/index.html" 2>/dev/null \
  | python3 -c 'import re,sys,json; m=re.search(r"<script type=\"application/json\" id=\"hovod-cues\">(.*?)</script>", sys.stdin.read(), re.S); print(json.dumps(json.loads(m.group(1)), indent=1))'
