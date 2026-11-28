#!/bin/sh
# Runs the Nøde router scripts on a real OpenWrt userland (CI: the openwrt/rootfs container), with
# real uci, busybox and config files. Only things a container can't do are stood in for: reloading
# services and Wi-Fi, and a radio (there is no Wi-Fi hardware).
#   docker run --rm -v "$PWD/firmware/openwrt:/fw" openwrt/rootfs:x86-64-23.05.6 sh /fw/test/e2e.sh
set -eu
cd /fw
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { # want <uci path> <value>
  got="$(uci -q get "$1" || echo '<unset>')"
  [ "$got" = "$2" ] || fail "$1 is '$got', want '$2'"
}
gone() { ! uci -q get "$1" >/dev/null 2>&1 || fail "$1 should be gone"; }

mkdir -p /etc/init.d /etc/crontabs /var/lock
for s in network firewall cron sqm; do printf '#!/bin/sh\nexit 0\n' > "/etc/init.d/$s"; chmod 755 "/etc/init.d/$s"; done
printf '#!/bin/sh\nexit 0\n' > /sbin/wifi; chmod 755 /sbin/wifi
touch /etc/config/wireless /etc/config/sqm /etc/config/network
# A real router writes its network config on first boot; the rootfs image has none.
uci set network.lan=interface; uci set network.lan.proto=static; uci set network.lan.ipaddr=192.168.1.1
uci set network.wan=interface; uci set network.wan.proto=dhcp; uci commit network
uci set wireless.radio0=wifi-device; uci set wireless.radio0.type=mac80211; uci set wireless.radio0.disabled=1
uci set wireless.default_radio0=wifi-iface; uci set wireless.default_radio0.device=radio0; uci set wireless.default_radio0.ssid=HomeNet
uci commit wireless

echo "== setup, paired"
echo "configs: $(ls /etc/config | tr '
' ' ')"
ROLE=home NODE_KEY=nr_e2etestkeye2etestkey00 MAX_MBPS=12 DAILY_MB=500 sh ./nod-setup.sh   || { ROLE=home NODE_KEY=nr_e2etestkeye2etestkey00 sh -x ./nod-setup.sh 2>&1 | tail -15; fail "nod-setup failed"; }
want node.settings.key nr_e2etestkeye2etestkey00
want node.settings.role home
want node.settings.active 0
want node.settings.max_mbps 12
want wireless.node_ap_radio0.ssid "Nøde"
want wireless.node_ap_radio0.network guest
want wireless.node_ap_radio0.isolate 1
want wireless.node_ap_radio0.disabled 1
want wireless.default_radio0.ssid HomeNet
want network.guest.ipaddr 10.77.0.1
want firewall.node_guest.forward REJECT
want firewall.node_guest_wan.dest wan
want firewall.node_guest_nolan.target REJECT
want sqm.node_guest.download 12000
want sqm.node_guest.eqdisc_opts dual-dsthost
grep -q '^\*/5 \* \* \* \* /usr/sbin/nod-sync$' /etc/crontabs/root || fail "cron line missing"
[ "$(grep -c nod- /etc/crontabs/root)" = 1 ] || fail "cron should have exactly one Nøde line"
for b in nod-limits nod-sync nod-update nod-status; do [ -x "/usr/sbin/$b" ] || fail "/usr/sbin/$b missing"; done
[ "$(stat -c %a /etc/config/node 2>/dev/null || echo 600)" = 600 ] || fail "/etc/config/node must be 600"

echo "== firewall compiles (fw4)"
if command -v fw4 >/dev/null 2>&1; then
  if fw4 -q print > /tmp/fw.nft 2>/tmp/fw.err; then
    grep -q 'guest' /tmp/fw.nft || fail "fw4 ruleset has no guest zone"
    grep -E 'Nøde guest no private nets|10\.0\.0\.0/8' /tmp/fw.nft | head -3
  else
    echo "(fw4 print couldn't run here: $(head -c 300 /tmp/fw.err))"
  fi
else
  echo "(no fw4 in this image)"
fi

echo "== limits: stopped by host"
/usr/sbin/nod-limits
[ "$(sed -n 1p /tmp/node-state)" = "stopped by host" ] || fail "state: $(sed -n 1p /tmp/node-state)"
want wireless.node_ap_radio0.disabled 1

echo "== limits: sharing"
uci set node.settings.active=1; uci commit node
/usr/sbin/nod-limits
[ "$(sed -n 1p /tmp/node-state)" = sharing ] || fail "state: $(sed -n 1p /tmp/node-state)"
want wireless.node_ap_radio0.disabled 0

echo "== limits: outside sharing hours"
other=$(( ( $(date +%H | sed 's/^0//') + 3 ) % 24 ))
uci set node.settings.hours="$other"; uci commit node
/usr/sbin/nod-limits
[ "$(sed -n 1p /tmp/node-state)" = "outside sharing hours" ] || fail "state: $(sed -n 1p /tmp/node-state)"
want wireless.node_ap_radio0.disabled 1
uci set node.settings.hours=''; uci commit node

echo "== sync with the app unreachable keeps settings and still applies limits"
uci set node.settings.api=http://127.0.0.1:9; uci commit node
NOD_UPDATE=/nonexistent /usr/sbin/nod-sync
want node.settings.active 1
[ "$(sed -n 1p /tmp/node-state)" = sharing ] || fail "state after sync: $(sed -n 1p /tmp/node-state)"

echo "== sync and update against a stand-in Nøde site (uhttpd)"
if command -v curl >/dev/null 2>&1 || { opkg update >/dev/null 2>&1 && opkg install curl >/dev/null 2>&1; }; then
  site=/tmp/site; mkdir -p "$site/api/router" "$site/firmware/openwrt"
  printf '%s' '{"hotspot":"hs_e2e","name":"E2E","ssid":"Nøde Café","active":false,"limits":{"maxMbps":25,"dailyMb":900,"hours":[8,9,10],"maxTempC":42},"poll":300}' > "$site/api/router/config"
  # The site serves new scripts: a nod-limits that marks itself, and the rest as they are.
  cp ./nod-sync.sh ./nod-update.sh ./nod-status.sh "$site/firmware/openwrt/"
  { cat ./nod-limits.sh; echo '# e2e-updated'; } > "$site/firmware/openwrt/nod-limits.sh"
  (cd "$site/firmware/openwrt" && sha256sum nod-limits.sh nod-sync.sh nod-update.sh nod-status.sh > SHA256SUMS)
  uhttpd -f -p 127.0.0.1:8099 -h "$site" & sleep 1
  uci set node.settings.api=http://127.0.0.1:8099; uci commit node
  rm -f /tmp/node-updated
  uci -q delete sqm.node_guest.eqdisc_opts; uci -q delete sqm.node_guest.iqdisc_opts; uci commit sqm   # a router set up before fair sharing
  /usr/sbin/nod-sync
  want sqm.node_guest.eqdisc_opts dual-dsthost
  want sqm.node_guest.iqdisc_opts dual-srchost
  want node.settings.active 0
  want node.settings.max_mbps 25
  want node.settings.daily_mb 900
  want node.settings.hours "8 9 10"
  want sqm.node_guest.download 25000
  want wireless.node_ap_radio0.ssid "Nøde Café"
  want wireless.node_ap_radio0.disabled 1
  grep -q '# e2e-updated' /usr/sbin/nod-limits || fail "nod-update didn't install the newer nod-limits"
  echo tampered >> "$site/firmware/openwrt/nod-sync.sh"
  cp /usr/sbin/nod-sync /tmp/sync.before
  rm -f /tmp/node-updated; /usr/sbin/nod-update
  cmp -s /usr/sbin/nod-sync /tmp/sync.before || fail "a tampered nod-sync was installed"
  uci set node.settings.active=1; uci set node.settings.hours=''; uci commit node
else
  echo "(skipped: no curl and opkg couldn't install it)"
fi

echo "== status"
/usr/sbin/nod-status > /tmp/status.txt
grep -q "paired:          yes" /tmp/status.txt || fail "status should say paired"
! grep -q nr_e2etestkey /tmp/status.txt || fail "status must not print the key"
cat /tmp/status.txt

echo "== setup again keeps the key"
ROLE=home sh ./nod-setup.sh
want node.settings.key nr_e2etestkeye2etestkey00
[ "$(grep -c nod- /etc/crontabs/root)" = 1 ] || fail "re-running setup duplicated the cron line"

echo "== uninstall"
sh ./nod-uninstall.sh
gone wireless.node_ap_radio0
gone network.guest
gone dhcp.guest
gone firewall.node_guest
gone firewall.node_guest_nolan
gone sqm.node_guest
want wireless.default_radio0.ssid HomeNet
[ ! -e /etc/config/node ] || fail "/etc/config/node should be removed"
! grep -q nod- /etc/crontabs/root || fail "cron line should be removed"
for b in nod-limits nod-sync nod-update nod-status; do [ ! -e "/usr/sbin/$b" ] || fail "/usr/sbin/$b should be removed"; done

echo "== mesh: relay and gateway"
uci set wireless.radio1=wifi-device; uci set wireless.radio1.type=mac80211; uci commit wireless
MESH=1 ROLE=relay sh ./nod-setup.sh 2>/dev/null && fail "a relay without MESH_KEY should be refused" || true
MK=meshkey-meshkey-meshkey-meshkey-0001
MESH=1 MESH_KEY=$MK ROLE=relay sh ./nod-setup.sh
want wireless.node_mesh_radio0.mode mesh
want wireless.node_mesh_radio0.encryption sae
want wireless.node_mesh_radio0.key "$MK"
want wireless.node_mesh_radio1.mesh_id nodemesh
want wireless.node_ap_radio1.ssid "Nøde"
want network.guest.proto none
want dhcp.guest.ignore 1
gone firewall.node_guest_wan
MESH=1 MESH_KEY=$MK ROLE=gateway sh ./nod-setup.sh
want network.guest.proto static
want network.guest.ipaddr 10.77.0.1
want firewall.node_guest_wan.dest wan
gone dhcp.guest.ignore
sh ./nod-uninstall.sh
gone wireless.node_mesh_radio0
gone wireless.node_mesh_radio1
gone wireless.node_ap_radio1

echo "ALL OK"
