# Remote SS Proxy Controller

[![CI](https://github.com/defdet/extensions-vpn/actions/workflows/ci.yml/badge.svg)](https://github.com/defdet/extensions-vpn/actions)
[![Release](https://img.shields.io/github/v/release/defdet/extensions-vpn)](https://github.com/defdet/extensions-vpn/releases/latest)

A VS Code extension that manages a remote Shadowsocks SOCKS proxy for **Remote-SSH** sessions. It installs and controls `sslocal` on the remote host, then configures VS Code's proxy settings so that all extensions respecting `http.proxy` route traffic through the tunnel.

## Install

1. Go to [**Releases**](https://github.com/defdet/extensions-vpn/releases/latest) and download the `.vsix` file.
2. Install it:

```
code --install-extension remote-ss-proxy-controller.vsix
```

Or in VS Code: **Extensions** → `⋯` menu → **Install from VSIX…**

## Quick Start

1. Connect to a remote host via **Remote-SSH**.
2. Open the Command Palette (`Ctrl+Shift+P`) and run **Proxy: Configure Access Key**.
3. Paste your `ssconf://`, `ss://`, `https://`, or `http://` key.
4. Run **Proxy: Enable** — this installs `sslocal`, starts the proxy, and sets remote VS Code proxy settings.

## Commands

| Command | Description |
|---|---|
| `Proxy: Configure Access Key` | Store access key in VS Code SecretStorage |
| `Proxy: Enable` | Install sslocal (if needed), start proxy, set remote proxy settings |
| `Proxy: Disable` | Stop proxy, clear proxy settings, uninstall sslocal |
| `Proxy: Status` | Show current proxy process and settings state |
| `Proxy: Test Connectivity` | Run a test request through the proxy |
| `Proxy: Show Logs` | Tail sslocal log output |
| `Proxy: Reinstall sslocal` | Force-reinstall the sslocal binary |
| `Proxy: Quick Actions` | Show all actions in a quick pick menu |

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteProxy.sshHost` | *(auto-detected)* | SSH host override |
| `remoteProxy.socksPort` | `1080` | SOCKS bind port on remote |
| `remoteProxy.shadowsocksVersion` | `v1.24.0` | sslocal release version |
| `remoteProxy.testUrl` | `https://api.openai.com/v1/models` | URL for connectivity test |
| `remoteProxy.logTailLines` | `80` | Number of log lines to fetch |
| `remoteProxy.confirmBeforeMutations` | `true` | Ask before enable/disable/reinstall |

## How It Works

1. Resolves the dynamic access key payload.
2. Installs `sslocal` binary to `~/.codex-ssproxy/bin/` on the remote host.
3. Starts a local SOCKS endpoint on `127.0.0.1:1080` (configurable).
4. Sets remote VS Code machine settings:
   - `http.proxy = socks5://127.0.0.1:1080`
   - `http.proxySupport = on`
5. All extensions that respect VS Code proxy settings will use the tunnel automatically.

## Requirements

- VS Code with **Remote-SSH** extension
- Remote host with `python3`, `curl`, and outbound access to the Shadowsocks endpoint
- PowerShell (Windows) or `pwsh` (macOS/Linux) on the local machine

## Notes

- This is **not** a system-wide VPN. It is a SOCKS proxy used by VS Code's extension-host network stack.
- Some external CLIs started by extensions may bypass the VS Code proxy.
- Only active during Remote-SSH sessions (`vscode.env.remoteName === "ssh-remote"`).

## Development

```bash
npm ci
npm run build
npm run test:unit
```

Package a local VSIX:

```bash
npx @vscode/vsce package
```

## License

[MIT](LICENSE)
