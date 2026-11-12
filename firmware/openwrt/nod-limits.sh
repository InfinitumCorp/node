#!/bin/sh
# Runs every 5 minutes from cron. Turns the Nøde guest AP on or off from:
#   node.settings.active   the host's start/stop switch (stop wins, always)
#   node.settings.hours    hours of the day sharing is allowed (empty = any)
#   node.settings.daily_mb guest data per day; counted on br-guest, reset at midnight
#   router temperature     stops above 85 °C SoC (hardware safety, not the phone limit)
set -eu

active="$(uci -q get node.settings.active || echo 0)"
hours="$(uci -q get node.settings.hours || echo '')"
daily_mb="$(uci -q get node.settings.daily_mb || echo 2048)"
state=/tmp/node-usage
today="$(date +%Y-%m-%d)"
hour="$(date +%H | sed 's/^0//')"

rx="$(cat /sys/class/net/br-guest/statistics/rx_bytes 2>/dev/null || echo 0)"
tx="$(cat /sys/class/net/br-guest/statistics/tx_bytes 2>/dev/null || echo 0)"
now_bytes=$((rx + tx))
if [ ! -f "$state" ] || [ "$(cut -d' ' -f1 "$state")" != "$today" ]; then echo "$today $now_bytes" > "$state"; fi
start_bytes="$(cut -d' ' -f2 "$state")"
[ "$now_bytes" -lt "$start_bytes" ] && { echo "$today $now_bytes" > "$state"; start_bytes=$now_bytes; }
used_mb=$(((now_bytes - start_bytes) / 1048576))

want=1
reason=""
[ "$active" = 1 ] || { want=0; reason="stopped by host"; }
if [ -n "$hours" ] && ! echo " $hours " | grep -q " $hour "; then want=0; reason="${reason:-outside sharing hours}"; fi
[ "$used_mb" -lt "$daily_mb" ] || { want=0; reason="${reason:-daily limit reached}"; }
for z in /sys/class/thermal/thermal_zone*/temp; do
  [ -f "$z" ] || continue
  t=$(( $(cat "$z") / 1000 ))
  [ "$t" -lt 85 ] || { want=0; reason="${reason:-too hot (${t}°C)}"; }
done

changed=0
for iface in $(uci show wireless | sed -n "s/^wireless\.\(node_ap_[^.=]*\)=wifi-iface$/\1/p"); do
  cur="$(uci -q get "wireless.$iface.disabled" || echo 1)"
  target=$((1 - want))
  if [ "$cur" != "$target" ]; then uci set "wireless.$iface.disabled=$target"; changed=1; fi
done
if [ "$changed" = 1 ]; then
  uci commit wireless
  wifi reload
  logger -t node "guest AP $( [ "$want" = 1 ] && echo on || echo "off: $reason" ) (used ${used_mb}/${daily_mb} MB today)"
fi
