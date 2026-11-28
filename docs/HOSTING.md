# Host Nøde on your router

[Русская версия](HOSTING.ru.md)

You share part of your internet with people nearby. They join a separate network called **Nøde** and can never reach your own devices. You choose a speed cap, a daily data limit and the hours, and you can stop at any time.

## Before you start

- **Your internet plan must allow sharing.** Many home plans don't. Business and venue plans often do. Check with your provider.
- **A router that runs OpenWrt 23.05 or newer.** Check yours in the [OpenWrt table of hardware](https://openwrt.org/toh/start). Keep your current router as it is if you're not comfortable reflashing it; a second, inexpensive OpenWrt router plugged into it works too.
- **Packages:** `wpad-mesh-mbedtls` (or `wpad-mesh-openssl`) for mesh, `sqm-scripts` for the speed cap. The installer adds `curl` itself.

## 1. Add your hotspot in the app

Open [node.infinitumcorporation.ai](https://node.infinitumcorporation.ai/#/host) (in Russia: [node-ru.infinitumcorporation.ai](https://node-ru.infinitumcorporation.ai/#/host)), sign in with Cumulus ID, turn on **Yes, I want to host** and add a hotspot. It starts **stopped**.

Under the hotspot, tap **Pair a router**. Copy the key that starts with `nr_`. It's shown once.

## 2. Install on the router

Connect to the router (`ssh root@192.168.1.1`) and run, with your key:

```sh
wget -qO /tmp/nod-install.sh https://node.infinitumcorporation.ai/firmware/openwrt/nod-install.sh && ROLE=home NODE_KEY='nr_...' sh /tmp/nod-install.sh
```

In Russia, without a VPN:

```sh
wget -qO /tmp/nod-install.sh https://node-ru.infinitumcorporation.ai/firmware/openwrt/nod-install.sh && ROLE=home NODE_API=https://node-ru.infinitumcorporation.ai NODE_KEY='nr_...' sh /tmp/nod-install.sh
```

`ROLE` is `home`, `business` (venue guest Wi-Fi), `relay` or `gateway`. Relays and gateways need `MESH=1 MESH_KEY=<32+ characters>`; use the same mesh key on every Nøde router you own. The installer checks every file against `SHA256SUMS` and stops before changing anything if a download is wrong.

## 3. Start sharing

Back in the app, tap **Start sharing**. Within 5 minutes the router turns on the Nøde network and the Host tab shows what it reported: "sharing" or why not, its temperature and the data guests used today.

The app is the switch. If the router can't reach the app it keeps its last settings, and it never turns sharing on by itself. If you unpair the router or remove the hotspot, the router stops sharing at its next check.

## Stop

- **Now, everywhere:** Host tab > **Stop sharing now**. Routers follow within 5 minutes.
- **Right now on the router:** `uci set node.settings.active=0; uci commit node; nod-limits`
- **For good:** run the uninstaller, then **Unpair** the router in the app:

```sh
wget -qO /tmp/nod-uninstall.sh https://node.infinitumcorporation.ai/firmware/openwrt/nod-uninstall.sh && sh /tmp/nod-uninstall.sh
```

## What the router sends

Every 5 minutes: its state ("sharing", "stopped by host", "outside sharing hours", "daily limit reached" or "too hot"), the hottest temperature sensor and the guest data used today. Nothing about guests: no devices, addresses or sites.

## Updates

Once a day the router checks for newer Nøde scripts. It installs one only if it matches the published `SHA256SUMS` and parses cleanly, so a bad download changes nothing. To turn this off: `uci set node.settings.autoupdate=0; uci commit node`. To update by hand: `nod-update`.

## Troubleshooting

On the router, `nod-status` shows the settings, the last check and recent log lines. It never prints the router key, so it's safe to send to support.

| What you see | What to do |
|---|---|
| "Hasn't checked in yet" | The key or the address is wrong, or curl is missing. On the router: `logread -e node`. Re-pair and run `uci set node.settings.key='nr_...'; uci commit node; nod-sync`. |
| "too hot" | The router stops sharing above 85 °C. Give it air. |
| "daily limit reached" | Raise **Guest data per day**, or wait until midnight. |
| No Nøde network | Check that sharing is started in the app and the hour is ticked (no hours ticked means any time). |
