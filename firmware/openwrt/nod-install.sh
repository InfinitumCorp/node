#!/bin/sh
# One-command Nøde router install for OpenWrt 23.05+. On the router (ssh root@192.168.1.1):
#
#   wget -qO /tmp/nod-install.sh https://node.infinitumcorporation.ai/firmware/openwrt/nod-install.sh && \
#     ROLE=home NODE_KEY='nr_...' sh /tmp/nod-install.sh
#
# Russia, without a VPN: use https://node-ru.infinitumcorporation.ai instead (it also becomes the router's API).
#
# It downloads nod-setup, nod-limits, nod-sync and nod-update from the same site, checks them against SHA256SUMS,
# installs curl if it's missing (needed for nod-sync), then runs nod-setup with your settings
# (ROLE, NODE_KEY, MESH, MESH_KEY, SSID, MAX_MBPS, DAILY_MB, HOURS, UPLINK; see nod-setup.sh).
# NODE_KEY comes from the app: Host > your hotspot > Pair a router. Without it the router works on its
# own settings and you start and stop it by hand.
set -eu

NODE_API="${NODE_API:-https://node.infinitumcorporation.ai}"
NODE_API="${NODE_API%/}"
base="$NODE_API/firmware/openwrt"
dir="$(mktemp -d /tmp/nod-fw.XXXXXX)"
trap 'rm -rf "$dir"' EXIT

fetch() { # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 60 -o "$2" "$1"; else wget -qO "$2" "$1"; fi
}

echo "Downloading Nøde router scripts from $base"
fetch "$base/SHA256SUMS" "$dir/SHA256SUMS"
for f in nod-setup.sh nod-limits.sh nod-sync.sh nod-update.sh nod-status.sh; do
  fetch "$base/$f" "$dir/$f"
  want="$(tr -d '\r' < "$dir/SHA256SUMS" | sed -n "s/^\([0-9a-f]\{64\}\) [ *]$f\$/\1/p")"
  got="$(sha256sum "$dir/$f" | cut -d' ' -f1)"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "$f didn't download correctly (checksum mismatch). Nothing was changed." >&2
    exit 1
  fi
done

if ! command -v curl >/dev/null 2>&1; then
  echo "Installing curl (nod-sync uses it to talk to the app)"
  opkg update >/dev/null && opkg install curl >/dev/null || echo "Couldn't install curl. The router will run on its own settings until you install it." >&2
fi

export NODE_API
cd "$dir"
sh ./nod-setup.sh
