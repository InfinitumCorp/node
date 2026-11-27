#!/bin/sh
# Removes Nøde from an OpenWrt router: the guest network, guest and mesh Wi-Fi, firewall rules,
# guest speed shaping, the cron job, the scripts and /etc/config/node (which holds the router key).
#
#   sh nod-uninstall.sh            or, if installed:   wget -qO- <site>/firmware/openwrt/nod-uninstall.sh | sh
#
# Your own Wi-Fi networks and LAN are left as they are. Radios that nod-setup switched on stay on.
# Unpair the router in the app too (Host > your hotspot > Unpair) so its key stops working there.
set -u

for s in $(uci show wireless 2>/dev/null | sed -n 's/^wireless\.\(node_ap_[^.=]*\|node_mesh_[^.=]*\)=wifi-iface$/\1/p'); do
  uci -q delete "wireless.$s"
done
for s in guest_dev guest; do uci -q delete "network.$s"; done
uci -q delete dhcp.guest
for s in node_guest node_guest_wan node_guest_dns node_guest_dhcp node_guest_nolan; do uci -q delete "firewall.$s"; done
[ -f /etc/config/sqm ] && uci -q delete sqm.node_guest
uci commit

if [ -f /etc/crontabs/root ]; then
  sed -i '/nod-limits\|nod-sync/d' /etc/crontabs/root
  /etc/init.d/cron restart >/dev/null 2>&1 || true
fi
rm -f /usr/sbin/nod-limits /usr/sbin/nod-sync /usr/sbin/nod-update /etc/config/node /tmp/node-state /tmp/node-usage

wifi reload >/dev/null 2>&1 || true
/etc/init.d/network reload >/dev/null 2>&1 || true
/etc/init.d/firewall reload >/dev/null 2>&1 || true
[ -x /etc/init.d/sqm ] && /etc/init.d/sqm reload >/dev/null 2>&1 || true
logger -t node "Nøde removed from this router" 2>/dev/null || true
echo "Nøde removed. Unpair this router in the app (Host > your hotspot > Unpair) if you haven't."
