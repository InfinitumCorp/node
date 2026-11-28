#!/bin/sh
# What this Nøde router is doing, in plain words. Run it on the router: nod-status
# Safe to share the output: it never prints the router key.
set -u

get() { uci -q get "node.settings.$1" 2>/dev/null || true; }
yes_no() { [ "$1" = 1 ] && echo yes || echo no; }

echo "Nøde on this router"
echo "  role:            $(get role)"
echo "  app address:     $(get api)"
key="$(get key)"
if [ -n "$key" ]; then echo "  paired:          yes"; else echo "  paired:          no (Host > your hotspot > Pair a router)"; fi
echo "  sharing switch:  $( [ "$(get active)" = 1 ] && echo on || echo off )"
hours="$(get hours)"
echo "  hours:           ${hours:-any time}"
echo "  speed cap:       $(get max_mbps) Mbit/s for all guests together"
echo "  data per day:    $(get daily_mb) MB"
au="$(get autoupdate)"
echo "  auto-update:     $(yes_no "${au:-1}")"

if [ -f /tmp/node-state ]; then
  echo "Last check"
  echo "  state:           $(sed -n 1p /tmp/node-state)"
  t="$(sed -n 2p /tmp/node-state)"; [ -n "$t" ] && echo "  hottest sensor:  ${t} °C"
  echo "  guest data today: $(sed -n 3p /tmp/node-state) MB"
  echo "  at:              $(date -r /tmp/node-state '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)"
else
  echo "Last check: none since the router started (cron runs nod-sync every 5 minutes)"
fi

up=0
for iface in $(uci show wireless 2>/dev/null | sed -n "s/^wireless\.\(node_ap_[^.=]*\)=wifi-iface$/\1/p"); do
  [ "$(uci -q get "wireless.$iface.disabled" || echo 1)" = 0 ] && up=$((up + 1))
done
echo "Guest Wi-Fi:       $( [ "$up" -gt 0 ] && echo "on ($up radio(s), network \"$(uci -q get wireless.node_ap_radio0.ssid 2>/dev/null || echo Nøde)\")" || echo off )"
grep -q nod-sync /etc/crontabs/root 2>/dev/null && echo "Schedule:          nod-sync every 5 minutes" || echo "Schedule:          missing; re-run nod-setup"
command -v curl >/dev/null 2>&1 || echo "Warning:           curl is missing, so the router can't reach the app (opkg update && opkg install curl)"

echo "Recent log"
logread -e node 2>/dev/null | tail -n 8 | sed 's/^/  /' || echo "  (no log)"
