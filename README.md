# Remote SS Proxy Controller

[![CI](https://github.com/defdet/extensions-vpn/actions/workflows/ci.yml/badge.svg)](https://github.com/defdet/extensions-vpn/actions)
[![Release](https://img.shields.io/github/v/release/defdet/extensions-vpn)](https://github.com/defdet/extensions-vpn/releases/latest)

A VS Code extension that manages a remote Shadowsocks SOCKS proxy for **Remote-SSH** sessions. It installs and controls a Shadowsocks client on the remote host (`sslocal` for plain SS, or `outline-helper` for networks where bare SS is fingerprinted by DPI), then configures VS Code's proxy settings so that all extensions respecting `http.proxy` route traffic through the tunnel.

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
4. Run **Proxy: Enable** — this installs the proxy binary (see [Bypassing payload-level DPI](#bypassing-payload-level-dpi)), starts the proxy, and sets remote VS Code proxy settings.
5. Apply the change (see [Applying Changes](#applying-changes) below).

## Applying Changes

After **Proxy: Enable**, what you need to do depends on which extension(s) you want proxied:

| Goal | What to do |
|---|---|
| Apply `http.proxy` to VS Code itself and to extensions that honor it | **Reload Window** (`Ctrl+Shift+P` → *Developer: Reload Window*) |
| Pick up proxy env in **new** integrated terminals | Open a new terminal — existing terminals keep their old env |
| Make Claude Code traverse the tunnel | **Reload Window** (the bundled `claude` binary is auto-wrapped during *Proxy: Enable*; the wrapper reads the current proxy URL on every invocation) |
| Proxy other extensions whose subprocesses strip env (rare) | **Remote-SSH: Kill VS Code Server on Host**, then reconnect. This causes `~/.vscode-server/server-env-setup` to be sourced fresh, so `HTTPS_PROXY` reaches the extension host process tree |

A plain Reload Window restarts only the extension host child, which inherits its env from the long-running VS Code Server. To re-source `server-env-setup` you must restart VS Code Server itself (Kill VS Code Server on Host).

After **Proxy: Disable**, do the same Reload Window (and Kill VS Code Server if you previously did) to roll back cleanly.

## Commands

| Command | Description |
|---|---|
| `Proxy: Configure Access Key` | Store access key in VS Code SecretStorage |
| `Proxy: Enable` | Install proxy binary (if needed), start proxy, set remote proxy settings |
| `Proxy: Disable` | Stop proxy, clear proxy settings, remove proxy binary |
| `Proxy: Status` | Show current proxy process and settings state (reports active backend) |
| `Proxy: Test Connectivity` | Run a test request through the proxy |
| `Proxy: Show Logs` | Tail proxy log output |
| `Proxy: Reinstall Proxy Binary` | Force-reinstall the active proxy binary (sslocal or outline-helper) |
| `Proxy: Quick Actions` | Show all actions in a quick pick menu |

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteProxy.sshHost` | *(auto-detected)* | SSH host override |
| `remoteProxy.socksPort` | `1080` | SOCKS5 bind port on remote |
| `remoteProxy.httpPort` | `1081` | HTTP CONNECT bind port on remote. Used for `HTTPS_PROXY`/`HTTP_PROXY` env so tools that only speak HTTP CONNECT (e.g. Node `undici`/`fetch`, Claude Code) can use the tunnel |
| `remoteProxy.shadowsocksVersion` | `v1.24.0` | sslocal release version |
| `remoteProxy.outlineHelperVersion` | `v0.7.0` | Tag in this repo to pull the `outline-helper` binary from. Used only when an Outline-style salt prefix is configured |
| `remoteProxy.outlinePrefixHex` | `16030301c29e02` | Hex-encoded salt prefix for Outline-compatible DPI evasion. Non-empty value switches the backend to `outline-helper`; clear it (or set to `""`) to use plain `sslocal`. See [Bypassing payload-level DPI](#bypassing-payload-level-dpi) |
| `remoteProxy.testUrl` | `https://api.openai.com/v1/models` | URL for connectivity test |
| `remoteProxy.testExpectedHttpCodes` | `200,204,301,302,307,308,401,403` | Comma-separated HTTP codes treated as successful |
| `remoteProxy.logTailLines` | `80` | Number of log lines to fetch |
| `remoteProxy.confirmBeforeMutations` | `false` | Ask before enable/disable/reinstall |
| `remoteProxy.wrapClaudeCode` | `true` | Auto-wrap the Anthropic Claude Code extension's bundled `claude` native binary so it inherits proxy env. Linux/macOS only. Restored on *Proxy: Disable* |

## How It Works

1. Resolves the dynamic access key payload.
2. Installs the active proxy binary to `~/.extensions-ssproxy/bin/` on the remote host:
   - `sslocal` (from `shadowsocks/shadowsocks-rust`) when `outlinePrefixHex` is empty
   - `outline-helper` (built from `tools/outline-helper`, attached to this repo's GitHub releases) when `outlinePrefixHex` is set
3. Starts a single process exposing two locals on `127.0.0.1`: SOCKS5 on `socksPort` and HTTP CONNECT on `httpPort` (both auto-fall-back if a port is in use). The active backend is recorded in `~/.extensions-ssproxy/state/active_backend`.
4. Propagates the proxy through three channels so different extension stacks all see it:
   - `http.proxy = http://127.0.0.1:<httpPort>` + `http.proxySupport = on` in remote machine settings (`~/.vscode-server/data/Machine/settings.json`)
   - `terminal.integrated.env.<os>.{HTTPS_PROXY,HTTP_PROXY,…}` so new integrated terminals inherit it
   - Marker-delimited block in `~/.vscode-server/server-env-setup` so VS Code Server exports the env to its extension host process tree on next startup
5. If `remoteProxy.wrapClaudeCode` is enabled, renames the Claude Code extension's bundled `claude` binary to `claude.real` and installs a small bash shim that re-exports proxy env (read from `~/.extensions-ssproxy/state/proxy_url`) before `exec`'ing the real binary. *Proxy: Disable* unwraps it.

Nothing system-wide is modified — login shells, cron, systemd, other users, and any process not spawned by VS Code Server are unaffected.

## Bypassing payload-level DPI

Some corporate / ISP networks fingerprint Shadowsocks traffic at the encrypted-payload layer: TCP handshake and SOCKS negotiation succeed, but the response from the SS upstream never round-trips back. With bare `sslocal` the symptom is `curl: (28) SSL connection timeout` on the test URL even though the SS server itself is reachable on TCP. Same key, same server, same `sslocal` — works on a cloud egress, hangs on the corporate one.

The fix is **Outline-compatible salt-prefix injection** (Jigsaw's anti-censorship work). The Shadowsocks salt — normally 32 random bytes prepended to every connection — is replaced with a fixed prefix followed by random bytes for the remainder. Choosing the prefix so the first bytes on the wire look like a TLS record header (default: `16030301c29e02` — TLS handshake content type + TLS 1.2 record version + length-shaped bytes) is enough to make the flow pass most fingerprinting middleboxes. No server-side change required: the salt is a public input to AEAD, so a vanilla `outline-ss-server` (or any AEAD SS server) accepts it transparently.

The extension ships `outline-helper`, a small Go binary built on [outline-sdk](https://github.com/Jigsaw-Code/outline-sdk) that:

- listens as SOCKS5 and HTTP CONNECT on the same two ports `sslocal` would have used,
- dials the SS upstream via `shadowsocks.StreamDialer` with `NewPrefixSaltGenerator(prefix)`,
- is launched in place of `sslocal` whenever `remoteProxy.outlinePrefixHex` is non-empty.

**Tuning:**

- Default prefix matches what the VanyaVPN client (built on [Outline](https://github.com/Jigsaw-Code/outline-apps)) injects — captured from its `tun2socks -proxyPrefix` argument. If your SS provider uses a different obfuscator, set `remoteProxy.outlinePrefixHex` to its hex-encoded prefix value, or clear it (`""`) to fall back to plain `sslocal`.
- The setting also accepts a prefix embedded in the access key URL itself: `ss://...?prefix=%16%03%03%01%C2%9E%02` (percent-encoded raw bytes — Outline's URL convention) or `ss://...?prefix=16030301c29e02` (hex). When both are present, the VS Code setting wins.
- `Proxy: Status` reports the active backend; `Proxy: Show Logs` tails whichever binary is running.

## Requirements

- VS Code with **Remote-SSH** extension
- Remote host with `python3`, `curl`, and outbound access to the Shadowsocks endpoint
- SSH client on the local machine (built-in on Windows 10+, macOS, and Linux)

> **Cross-platform:** Works on Windows, macOS, and Linux — no PowerShell or other shell dependencies.

## Notes

- This is **not** a system-wide VPN. It only proxies VS Code's extension-host process tree (and, when enabled, the wrapped Claude Code binary).
- Some external CLIs started by extensions may bypass the VS Code proxy if they strip env and don't speak `http.proxy`. The Claude Code wrap is a targeted workaround for one such case.
- Works in both Remote-SSH sessions and locally (the same script also runs on the local host when invoked without a remote authority).

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
