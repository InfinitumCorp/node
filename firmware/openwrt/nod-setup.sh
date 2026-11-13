#!/bin/sh
# Nøde router setup for OpenWrt 23.05+ (needs: wpad-mesh-mbedtls or wpad-mesh-openssl, sqm-scripts, nodogsplash optional).
#
#   ROLE=home|business|relay|gateway [MESH=1 MESH_KEY=<32+ chars>] sh nod-setup.sh
#
# What it does:
#  - Guest AP "Nøde" on its own bridge (br-guest, 10.77.0.0/22). Guests are client-isolated and the
#    firewall drops guest -> LAN, so they can never reach the host's devices.
#  - 802.11s mesh backhaul "nodemesh" (SAE-encrypted) between Nøde routers; phones never join the mesh,
#    they join the guest AP. Relays and gateways extend coverage over the mesh.
#  - SQM caps on guest traffic from /etc/config/node (max_mbps), so the host's own use comes first.
#  - A daily data cap and schedule are enforced by nod-limits.sh (installed to cron).
#
#  - Paired with the app (NODE_KEY=nr_... from Host > Pair a router), nod-sync.sh follows the app's
#    start/stop switch and limits and reports back. Needs curl for that (opkg install curl).
#
# Run it on a test router first. It changes wireless, network and firewall config, then reloads them.
set -eu

ROLE="${ROLE:-home}"
MESH_KEY="${MESH_KEY:-}"
SSID="${SSID:-Nøde}"
MAX_MBPS="${MAX_MBPS:-10}"
DAILY_MB="${DAILY_MB:-2048}"
HOURS="${HOURS:-}"          # e.g. "8 9 10 11 12 13 14 15 16 17 18 19 20 21"; empty = always
UPLINK="${UPLINK:-wan}"
MESH="${MESH:-0}"            # 1 = join the nodemesh backhaul with other Nøde routers

case "$ROLE" in home|business|relay|gateway) ;; *) echo "ROLE must be home, business, relay or gateway" >&2; exit 1 ;; esac
if [ "$MESH" = 1 ] && [ "${#MESH_KEY}" -lt 32 ]; then echo "MESH=1 needs MESH_KEY of at least 32 characters (keep it out of git)" >&2; exit 1; fi
[ "$ROLE" != relay ] || [ "$MESH" = 1 ] || { echo "A relay only makes sense with MESH=1" >&2; exit 1; }

# ---- Nøde settings, read by nod-limits.sh and nod-sync.sh ----
# A router key from the app (Host > Pair a router) survives re-running setup.
NODE_KEY="${NODE_KEY:-$(uci -q get node.settings.key || true)}"
NODE_API="${NODE_API:-$(uci -q get node.settings.api || echo https://node.infinitumcorporation.ai)}"
uci -q delete node.settings || true
touch /etc/config/node
chmod 600 /etc/config/node   # holds the router key
uci set node.settings=node
uci set node.settings.api="$NODE_API"
[ -z "$NODE_KEY" ] || uci set node.settings.key="$NODE_KEY"
uci set node.settings.role="$ROLE"
uci set node.settings.max_mbps="$MAX_MBPS"
uci set node.settings.daily_mb="$DAILY_MB"
uci set node.settings.hours="$HOURS"
uci set node.settings.active='0'   # starts stopped; the host turns it on in the app

# ---- guest network ----
uci -q delete network.guest_dev || true
uci set network.guest_dev=device
uci set network.guest_dev.type='bridge'
uci set network.guest_dev.name='br-guest'
uci -q delete network.guest || true
uci set network.guest=interface
uci set network.guest.proto='static'
uci set network.guest.device='br-guest'
uci set network.guest.ipaddr='10.77.0.1'
uci set network.guest.netmask='255.255.252.0'

uci -q delete dhcp.guest || true
uci set dhcp.guest=dhcp
uci set dhcp.guest.interface='guest'
uci set dhcp.guest.start='10'
uci set dhcp.guest.limit='1000'
uci set dhcp.guest.leasetime='1h'

# ---- addressing: one gateway serves the guest subnet per mesh island ----
# With MESH=1 the 802.11s links are bridged into br-guest (one layer-2 guest network). Only the
# gateway hands out addresses and routes to the internet; home, business and relay nodes just carry
# guests to it. With MESH=0 (a single router) every role serves its own guests.
if [ "$MESH" = 1 ] && [ "$ROLE" != gateway ]; then
  uci set network.guest.proto='none'
  uci -q delete network.guest.ipaddr || true
  uci -q delete network.guest.netmask || true
  uci set dhcp.guest.ignore='1'
fi

for radio in $(uci show wireless | sed -n 's/^wireless\.\([^.=]*\)=wifi-device$/\1/p'); do
  uci set "wireless.$radio.disabled=0"
  # guest AP: relays carry one too, so they extend coverage
  uci -q delete "wireless.node_ap_$radio" || true
  uci set "wireless.node_ap_$radio=wifi-iface"
  uci set "wireless.node_ap_$radio.device=$radio"
  uci set "wireless.node_ap_$radio.mode=ap"
  uci set "wireless.node_ap_$radio.network=guest"
  uci set "wireless.node_ap_$radio.ssid=$SSID"
  uci set "wireless.node_ap_$radio.encryption=owe"      # Enhanced Open: encrypted without a password
  uci set "wireless.node_ap_$radio.isolate=1"
  uci set "wireless.node_ap_$radio.disabled=1"           # nod-limits.sh enables it when sharing is on
  # mesh link
  [ "$MESH" = 1 ] || continue
  uci -q delete "wireless.node_mesh_$radio" || true
  uci set "wireless.node_mesh_$radio=wifi-iface"
  uci set "wireless.node_mesh_$radio.device=$radio"
  uci set "wireless.node_mesh_$radio.mode=mesh"
  uci set "wireless.node_mesh_$radio.mesh_id=nodemesh"
  uci set "wireless.node_mesh_$radio.encryption=sae"
  uci set "wireless.node_mesh_$radio.key=$MESH_KEY"
  uci set "wireless.node_mesh_$radio.mesh_fwding=1"
  uci set "wireless.node_mesh_$radio.network=guest"
done

# ---- firewall: guest may reach the internet (only via a gateway/home/business uplink), never the LAN ----
uci -q delete firewall.node_guest || true
uci set firewall.node_guest=zone
uci set firewall.node_guest.name='guest'
uci set firewall.node_guest.network='guest'
uci set firewall.node_guest.input='REJECT'
uci set firewall.node_guest.output='ACCEPT'
uci set firewall.node_guest.forward='REJECT'
uci -q delete firewall.node_guest_wan || true
if [ "$ROLE" = gateway ] || [ "$MESH" != 1 ]; then
  uci set firewall.node_guest_wan=forwarding
  uci set firewall.node_guest_wan.src='guest'
  uci set firewall.node_guest_wan.dest="$UPLINK"
fi
for svc in dns:53:udp dhcp:67:udp; do
  name="${svc%%:*}"; rest="${svc#*:}"; port="${rest%%:*}"; proto="${rest#*:}"
  uci -q delete "firewall.node_guest_$name" || true
  uci set "firewall.node_guest_$name=rule"
  uci set "firewall.node_guest_$name.name=Nøde guest $name"
  uci set "firewall.node_guest_$name.src=guest"
  uci set "firewall.node_guest_$name.dest_port=$port"
  uci set "firewall.node_guest_$name.proto=$proto"
  uci set "firewall.node_guest_$name.target=ACCEPT"
done
# Block guests from private ranges the host uses (belt and braces on top of the zone).
uci -q delete firewall.node_guest_nolan || true
uci set firewall.node_guest_nolan=rule
uci set firewall.node_guest_nolan.name='Nøde guest no private nets'
uci set firewall.node_guest_nolan.src='guest'
uci set firewall.node_guest_nolan.dest='*'
uci add_list firewall.node_guest_nolan.dest_ip='192.168.0.0/16'
uci add_list firewall.node_guest_nolan.dest_ip='172.16.0.0/12'
uci add_list firewall.node_guest_nolan.dest_ip='10.0.0.0/8'
uci set firewall.node_guest_nolan.target='REJECT'

# ---- SQM guest shaping ----
if [ -f /etc/config/sqm ]; then
  uci -q delete sqm.node_guest || true
  uci set sqm.node_guest=queue
  uci set sqm.node_guest.enabled='1'
  uci set sqm.node_guest.interface='br-guest'
  uci set sqm.node_guest.download="$((MAX_MBPS * 1000))"
  uci set sqm.node_guest.upload="$((MAX_MBPS * 1000))"
  uci set sqm.node_guest.qdisc='cake'
  uci set sqm.node_guest.script='piece_of_cake.qos'
fi

uci commit
cp "$(dirname "$0")/nod-limits.sh" /usr/sbin/nod-limits && chmod 755 /usr/sbin/nod-limits
cp "$(dirname "$0")/nod-sync.sh" /usr/sbin/nod-sync && chmod 755 /usr/sbin/nod-sync
# nod-sync fetches the app's settings when the router is paired, then runs nod-limits either way.
touch /etc/crontabs/root
sed -i '/nod-limits\|nod-sync/d' /etc/crontabs/root
echo '*/5 * * * * /usr/sbin/nod-sync' >> /etc/crontabs/root
/etc/init.d/cron restart >/dev/null 2>&1 || true
/etc/init.d/network reload
/etc/init.d/firewall reload
[ -x /etc/init.d/sqm ] && /etc/init.d/sqm reload || true
if [ -n "$NODE_KEY" ]; then echo "Nøde $ROLE configured and paired. Start sharing from the app; the router follows within 5 minutes."
else echo "Nøde $ROLE configured. Sharing is OFF. Pair it in the app (Host > Pair a router), or start it by hand: uci set node.settings.active=1; uci commit node; nod-limits"; fi
