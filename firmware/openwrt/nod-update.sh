#!/bin/sh
# Keeps the router's Nøde scripts current. nod-sync runs it about once a day on paired routers.
#
# It downloads SHA256SUMS from the Nøde site the router already talks to (node.settings.api), and for
# each installed script whose checksum differs it downloads the new one, checks it against SHA256SUMS
# and that it parses as sh, then swaps it in. A file that fails either check is left as it was.
#
# Turn it off: uci set node.settings.autoupdate=0; uci commit node
set -u

BIN="${NOD_BIN:-/usr/sbin}"
api="${NODE_API:-$(uci -q get node.settings.api || echo https://node.infinitumcorporation.ai)}"
api="${api%/}"
base="$api/firmware/openwrt"
log() { logger -t node "update: $*" 2>/dev/null || echo "update: $*" >&2; }

[ "$(uci -q get node.settings.autoupdate || echo 1)" = 0 ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

dir="$(mktemp -d /tmp/nod-up.XXXXXX)"
trap 'rm -rf "$dir"' EXIT
curl -fsS --max-time 30 -o "$dir/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null || { log "couldn't reach $base"; exit 0; }

changed=0
for pair in nod-limits.sh:nod-limits nod-sync.sh:nod-sync nod-update.sh:nod-update nod-status.sh:nod-status; do
  src="${pair%%:*}"; dst="$BIN/${pair#*:}"
  want="$(tr -d '\r' < "$dir/SHA256SUMS" | sed -n "s/^\([0-9a-f]\{64\}\) [ *]$src\$/\1/p")"
  [ -n "$want" ] || continue
  if [ -f "$dst" ] && [ "$(sha256sum "$dst" | cut -d' ' -f1)" = "$want" ]; then continue; fi
  if ! curl -fsS --max-time 60 -o "$dir/$src" "$base/$src" 2>/dev/null; then log "couldn't download $src"; continue; fi
  if [ "$(sha256sum "$dir/$src" | cut -d' ' -f1)" != "$want" ]; then log "$src checksum mismatch, kept the old one"; continue; fi
  if ! sh -n "$dir/$src" 2>/dev/null; then log "$src doesn't parse, kept the old one"; continue; fi
  # A new file and a rename, so a copy of the script that is running right now keeps reading the old one.
  cp "$dir/$src" "$dst.new" && chmod 755 "$dst.new" && mv -f "$dst.new" "$dst" && { log "installed new $src"; changed=1; }
done
[ "$changed" = 1 ] || log "up to date"
exit 0
