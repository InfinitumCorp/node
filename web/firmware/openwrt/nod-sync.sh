#!/bin/sh
# Runs every 5 minutes from cron (instead of nod-limits on its own). Keeps the router in step with
# the Nøde app, then applies the limits:
#   1. GET  /api/router/config  -> node.settings.active / max_mbps / daily_mb / hours and the guest SSID
#   2. nod-limits                -> turns the guest AP on or off and records why in /tmp/node-state
#   3. POST /api/router/status  <- that state, the hottest thermal zone and guest MB today
#
# Pair once in the app (Host > your hotspot > Pair a router), then on the router:
#   uci set node.settings.key='nr_...'; uci commit node
# Russia: uci set node.settings.api='https://node-ru.infinitumcorporation.ai' (the Nøde mirror).
#
# No key, or the server can't be reached: the router keeps its last settings. It never turns
# sharing on by itself. If the app refuses the key (unpaired, or the hotspot was removed), it stops sharing. Needs curl (opkg install curl); jsonfilter is part of OpenWrt.
set -u

LIMITS="${NOD_LIMITS:-/usr/sbin/nod-limits}"
STATE=/tmp/node-state
key="$(uci -q get node.settings.key || true)"
api="$(uci -q get node.settings.api || echo https://node.infinitumcorporation.ai)"
api="${api%/}"

if [ -z "$key" ]; then exec "$LIMITS"; fi
if ! command -v curl >/dev/null 2>&1; then
  logger -t node "nod-sync needs curl: opkg update && opkg install curl"
  exec "$LIMITS"
fi

# The key goes in a header file readable only by root, so it never shows up in a process list or a URL.
umask 077
hdr="$(mktemp /tmp/node-auth.XXXXXX)"
out="$(mktemp /tmp/node-cfg.XXXXXX)"
trap 'rm -f "$hdr" "$out"' EXIT
printf 'Authorization: Bearer %s\n' "$key" > "$hdr"

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
changed_node=0
set_node() { # set_node <option> <value>
  cur="$(uci -q get "node.settings.$1" || true)"
  if [ "$cur" != "$2" ]; then uci set "node.settings.$1=$2"; changed_node=1; fi
}

code="$(curl -sS --max-time 20 -H @"$hdr" -o "$out" -w '%{http_code}' "$api/api/router/config" 2>/dev/null || true)"
cfg=""; [ "$code" = 200 ] && cfg="$(cat "$out")"
if [ "$code" = 401 ]; then
  # The key was revoked: the router was unpaired or its hotspot removed in the app. Stop sharing
  # rather than carry on with settings nobody can change any more.
  if [ "$(uci -q get node.settings.active || true)" != 0 ]; then
    uci set node.settings.active=0; uci commit node
    logger -t node "sync: the app no longer knows this router's key (unpaired or hotspot removed); stopped sharing. Pair it again in the Host tab."
  fi
elif [ -z "$cfg" ]; then
  logger -t node "sync: $api unreachable (HTTP ${code:-none}); keeping last settings"
else
  active="$(echo "$cfg" | jsonfilter -e '@.active' 2>/dev/null || true)"
  max="$(echo "$cfg" | jsonfilter -e '@.limits.maxMbps' 2>/dev/null || true)"
  daily="$(echo "$cfg" | jsonfilter -e '@.limits.dailyMb' 2>/dev/null || true)"
  hours="$(echo "$cfg" | jsonfilter -e '@.limits.hours[*]' 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
  ssid="$(echo "$cfg" | jsonfilter -e '@.ssid' 2>/dev/null || true)"

  if [ "$active" = true ] || [ "$active" = false ]; then
    set_node active "$([ "$active" = true ] && echo 1 || echo 0)"
  fi
  is_uint "$daily" && set_node daily_mb "$daily"
  ok_hours=1; for h in $hours; do is_uint "$h" && [ "$h" -le 23 ] || ok_hours=0; done
  [ "$ok_hours" = 1 ] && set_node hours "$hours"
  old_max="$(uci -q get node.settings.max_mbps || true)"
  is_uint "$max" && set_node max_mbps "$max"
  [ "$changed_node" = 1 ] && uci commit node

  if is_uint "$max" && [ "$max" != "$old_max" ] && [ -f /etc/config/sqm ] && uci -q get sqm.node_guest >/dev/null; then
    uci set sqm.node_guest.download="$((max * 1000))"
    uci set sqm.node_guest.upload="$((max * 1000))"
    uci commit sqm
    [ -x /etc/init.d/sqm ] && /etc/init.d/sqm reload || true
    logger -t node "sync: guest speed cap now ${max} Mbit/s"
  fi

  # Routers set up before the private-networks rule covered every protocol get the fix.
  if uci -q get firewall.node_guest_nolan >/dev/null && [ "$(uci -q get firewall.node_guest_nolan.proto || true)" != all ]; then
    uci set firewall.node_guest_nolan.proto='all'
    uci commit firewall
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
    logger -t node "sync: guests are now kept off private networks for every protocol"
  fi

  # Routers set up before guest DNS allowed TCP (large answers fall back to it).
  if uci -q get firewall.node_guest_dns >/dev/null && [ "$(uci -q get firewall.node_guest_dns.proto || true)" = udp ]; then
    uci set firewall.node_guest_dns.proto='tcp udp'
    uci commit firewall
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
    logger -t node "sync: guests' DNS now works over TCP too"
  fi

  # Routers set up before fair sharing existed get it on their next sync.
  if [ -f /etc/config/sqm ] && uci -q get sqm.node_guest >/dev/null && [ -z "$(uci -q get sqm.node_guest.eqdisc_opts || true)" ]; then
    uci set sqm.node_guest.qdisc_advanced='1'
    uci set sqm.node_guest.qdisc_really_really_advanced='1'
    uci set sqm.node_guest.eqdisc_opts='dual-dsthost'
    uci set sqm.node_guest.iqdisc_opts='dual-srchost'
    uci commit sqm
    [ -x /etc/init.d/sqm ] && /etc/init.d/sqm reload || true
    logger -t node "sync: guests now share the speed cap fairly"
  fi

  if [ -n "$ssid" ] && [ "${#ssid}" -le 32 ]; then
    changed_ssid=0
    for iface in $(uci show wireless | sed -n "s/^wireless\.\(node_ap_[^.=]*\)=wifi-iface$/\1/p"); do
      if [ "$(uci -q get "wireless.$iface.ssid" || true)" != "$ssid" ]; then uci set "wireless.$iface.ssid=$ssid"; changed_ssid=1; fi
    done
    if [ "$changed_ssid" = 1 ]; then uci commit wireless; wifi reload; logger -t node "sync: guest network name now $ssid"; fi
  fi
fi

"$LIMITS" || true

# Report what nod-limits decided. Only the host's own figures: no guest devices, no addresses.
if [ -f "$STATE" ] && [ "$code" != 401 ]; then
  # Quotes, backslashes and control characters would break the JSON below.
  state="$(sed -n 1p "$STATE" | tr -d '"\\' | tr -d '[:cntrl:]' | cut -c1-60)"
  temp="$(sed -n 2p "$STATE")"
  used="$(sed -n 3p "$STATE")"
  body="{\"state\":\"${state:-unknown}\""
  is_uint "$temp" && body="$body,\"tempC\":$temp"
  is_uint "$used" && body="$body,\"usedMb\":$used"
  body="$body}"
  curl -fsS --max-time 20 -H @"$hdr" -H 'content-type: application/json' -d "$body" "$api/api/router/status" >/dev/null 2>&1 \
    || logger -t node "sync: couldn't report status"
fi

# About once a day (and after each reboot, since /tmp is cleared), pick up newer Nøde scripts.
UPDATE="${NOD_UPDATE:-/usr/sbin/nod-update}"
stamp=/tmp/node-updated
if [ -x "$UPDATE" ] && [ "$(cat "$stamp" 2>/dev/null)" != "$(date +%Y-%m-%d)" ]; then
  date +%Y-%m-%d > "$stamp"
  NODE_API="$api" "$UPDATE" || true
fi
