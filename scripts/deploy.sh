#!/bin/sh
# Rebuild and restart the persistent instance (launchd: local.quire, or $QUIRE_LABEL),
# the one Tailscale serves. `npm run dev` is unaffected. A page open on a
# phone keeps unsaved typing on the device and sends it once the server is back.
set -e
cd "$(dirname "$0")/.."
PORT=8710
LABEL="${QUIRE_LABEL:-local.quire}"
npm run build
launchctl kickstart -k "gui/$(id -u)/$LABEL"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sfo /dev/null "http://127.0.0.1:$PORT/"; then echo "quire: deployed"; exit 0; fi
  sleep 1
done
echo "quire: restarted, but not answering on :$PORT -- see ~/Library/Logs/$LABEL.log" >&2
exit 1
