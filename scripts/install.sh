#!/bin/sh
# One time: install the launchd agent, build, start it, and serve it on the
# tailnet at :8448. After this, `npm run deploy` is all a change needs.
#
#   sh scripts/install.sh                     (label local.quire)
#   QUIRE_LABEL=my.quire sh scripts/install.sh
set -e
cd "$(dirname "$0")/.."
LABEL="${QUIRE_LABEL:-local.quire}"
# The real node install, not a version manager's shim: launchd runs without the shell setup a shim needs.
NODE_BIN="$(dirname "$(node -p 'process.execPath')")"
NPM="$NODE_BIN/npm"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|__LABEL__|$LABEL|" -e "s|__NPM__|$NPM|" -e "s|__DIR__|$(pwd)|" \
  -e "s|__PATH__|$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin|" \
  -e "s|__LOG__|$HOME/Library/Logs/$LABEL.log|g" \
  scripts/quire.plist > "$PLIST"
npm run build
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8448 http://127.0.0.1:8710
echo "quire: installed as $LABEL; on the tailnet at :8448"
