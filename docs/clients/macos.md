# macOS menu bar

A small menu-bar app under `macos/JepBar` that answers two questions about the
daemon on this Mac: is it up, and how do I pair a phone. It holds no state of
its own. Every 2 seconds it reads the `pairing-status.json` the daemon writes to
`JEP_DATA_HOME` (default `~/.local/share/jep-tg`, the same one `npm run pair`
reads) and calls the gateway's `/health`.

Download `JepBar-<version>.zip` from the
[latest release](https://github.com/tinybig-ai/jep/releases/latest), unzip it
into Applications, and open it the first time with right-click → Open (it isn't
notarized). Or run it from a checkout:

```sh
cd macos/JepBar && swift run -c release
```

It needs macOS 14 or newer and the gateway turned on (`JEP_GW_PORT`).

- **Status:** the dot in the menu bar is filled while the gateway answers. The
  window shows how many devices are paired.
- **Pairing QR:** encodes `jep://pair?address=<host>:<port>&code=<code>`. Scan it
  with the phone's camera and the Android or iOS app pairs in one step. It is
  ignored once the app is already paired. The address is this Mac's Tailscale
  IP when it has one, then its LAN address; pick another in the window. The
  code is single-use, and the QR refreshes after each pairing.
- **Manual:** the address and code are shown under the QR, for typing into the
  pair screen.

`JepBarCore` is Foundation-only, so its tests run on Linux as well:

```sh
cd macos/JepBar && swift test
```
