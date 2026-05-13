/**
 * Bash scripts that run either on a remote SSH host or locally.
 *
 * These scripts are cross-platform: they detect the host OS (Linux, macOS,
 * Windows via Git Bash) and adjust binary targets, archive formats, binary
 * names, VS Code settings paths, and process management accordingly.
 */

// ---------------------------------------------------------------------------
// Setup / lifecycle script
// Supports actions: up, down, status, test, logs, install
// ---------------------------------------------------------------------------
export const SETUP_REMOTE_SCRIPT = `set -euo pipefail

ACTION="\${ACTION:-status}"
SOCKS_PORT="\${SOCKS_PORT:-1080}"
HTTP_PORT="\${HTTP_PORT:-1081}"
SS_VERSION="\${SS_VERSION:-v1.24.0}"
SERVER_INFO_B64="\${SERVER_INFO_B64:-}"
TEST_URL="\${TEST_URL:-https://api.openai.com/v1/models}"
TEST_EXPECTED_HTTP_CODES="\${TEST_EXPECTED_HTTP_CODES:-200,204,301,302,307,308,401,403}"
TAIL_LINES="\${TAIL_LINES:-80}"
WRAP_CLAUDE_CODE="\${WRAP_CLAUDE_CODE:-1}"

BASE_DIR="$HOME/.extensions-ssproxy"
BIN_DIR="$BASE_DIR/bin"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/log"
TMP_DIR="$BASE_DIR/tmp"
PID_FILE="$STATE_DIR/sslocal.pid"
CFG_FILE="$STATE_DIR/config.json"
LAUNCH_CFG_FILE="$STATE_DIR/launch_config.json"
LOG_FILE="$LOG_DIR/sslocal.log"
SOCKS_PORT_FILE="$STATE_DIR/socks_port"
HTTP_PORT_FILE="$STATE_DIR/http_port"
PROXY_URL_FILE="$STATE_DIR/proxy_url"
ENV_SETUP_FILE="$HOME/.vscode-server/server-env-setup"

# Detect host OS for cross-platform support
HOST_OS="linux"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
  Darwin) HOST_OS="macos" ;;
esac

# Set binary name based on OS
if [ "$HOST_OS" = "windows" ]; then
  SSLOCAL_BIN="$BIN_DIR/sslocal.exe"
else
  SSLOCAL_BIN="$BIN_DIR/sslocal"
fi

# Auto-detect VS Code settings path: remote (.vscode-server) vs local
IS_VSCODE_SERVER=0
if [ -d "$HOME/.vscode-server" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/.vscode-server/data/Machine/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode-server/extensions"
  IS_VSCODE_SERVER=1
elif [ "$HOST_OS" = "macos" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode/extensions"
elif [ "$HOST_OS" = "windows" ]; then
  VSCODE_MACHINE_SETTINGS="$APPDATA/Code/User/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode/extensions"
else
  VSCODE_MACHINE_SETTINGS="$HOME/.config/Code/User/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode/extensions"
fi

mkdir -p "$BIN_DIR" "$STATE_DIR" "$LOG_DIR" "$TMP_DIR"
mkdir -p "$(dirname "$VSCODE_MACHINE_SETTINGS")"

# For non-up actions, read the stored ports so status/test/logs use the right ones
if [ "$ACTION" != "up" ]; then
  if [ -f "$SOCKS_PORT_FILE" ]; then
    sp="$(cat "$SOCKS_PORT_FILE" 2>/dev/null || true)"
    [ -n "$sp" ] && SOCKS_PORT="$sp"
  fi
  if [ -f "$HTTP_PORT_FILE" ]; then
    hp="$(cat "$HTTP_PORT_FILE" 2>/dev/null || true)"
    [ -n "$hp" ] && HTTP_PORT="$hp"
  fi
fi

log() {
  # Write to stdout (not stderr): some SSH setups buffer/swallow stderr until
  # process exit, hiding all [OK]/[INFO] log lines from the extension's output
  # channel. stdout is reliably streamed line-by-line.
  printf '[%s][%s] %s\\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$1" "$2"
}

# Find python — prefer python3 but fall back to python (Windows)
find_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
  elif command -v python >/dev/null 2>&1; then
    echo "python"
  else
    log ERROR "python3 (or python) is required but not found."
    return 1
  fi
}

detect_target() {
  local arch os_tag
  arch="$(uname -m)"
  case "$HOST_OS" in
    windows)
      case "$arch" in
        x86_64)       echo "x86_64-pc-windows-msvc" ;;
        aarch64|arm64) echo "aarch64-pc-windows-msvc" ;;
        *) echo "unsupported:\${arch}" ;;
      esac
      ;;
    macos)
      case "$arch" in
        x86_64)       echo "x86_64-apple-darwin" ;;
        aarch64|arm64) echo "aarch64-apple-darwin" ;;
        *) echo "unsupported:\${arch}" ;;
      esac
      ;;
    *)
      case "$arch" in
        x86_64)       echo "x86_64-unknown-linux-gnu" ;;
        aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
        *) echo "unsupported:\${arch}" ;;
      esac
      ;;
  esac
}

install_sslocal() {
  if [ -x "$SSLOCAL_BIN" ]; then
    log INFO "sslocal already installed: $SSLOCAL_BIN"
    "$SSLOCAL_BIN" --version | head -n1 | sed 's/^/[sslocal-version] /'
    return 0
  fi

  local target
  target="$(detect_target)"
  if [[ "$target" == unsupported:* ]]; then
    log ERROR "Unsupported architecture for auto-install: \${target#unsupported:}"
    return 2
  fi

  local archive url tmp bin_name
  if [ "$HOST_OS" = "windows" ]; then
    archive="shadowsocks-\${SS_VERSION}.\${target}.zip"
    bin_name="sslocal.exe"
  else
    archive="shadowsocks-\${SS_VERSION}.\${target}.tar.xz"
    bin_name="sslocal"
  fi
  url="https://github.com/shadowsocks/shadowsocks-rust/releases/download/\${SS_VERSION}/\${archive}"
  tmp="$(mktemp -d "$TMP_DIR/install.XXXXXX")"

  log INFO "Downloading $url"
  curl -fL --retry 3 --connect-timeout 15 "$url" -o "$tmp/$archive"
  if [ "$HOST_OS" = "windows" ]; then
    unzip -o "$tmp/$archive" -d "$tmp" >/dev/null 2>&1 || {
      log INFO "unzip not found, trying python zip extraction..."
      local py_bin
      py_bin="$(find_python)"
      "$py_bin" -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$tmp/$archive" "$tmp"
    }
  else
    tar -xf "$tmp/$archive" -C "$tmp"
  fi
  if [ ! -f "$tmp/$bin_name" ]; then
    log ERROR "$bin_name not found in extracted archive."
    return 3
  fi

  if [ "$HOST_OS" = "windows" ]; then
    cp "$tmp/$bin_name" "$SSLOCAL_BIN"
  else
    install -m 0755 "$tmp/$bin_name" "$SSLOCAL_BIN"
  fi
  rm -rf "$tmp"
  log OK "Installed sslocal to $SSLOCAL_BIN"
  "$SSLOCAL_BIN" --version | head -n1 | sed 's/^/[sslocal-version] /'
}

probe_port_with_python() {
  local port="$1"
  local py_bin=""
  if command -v python3 >/dev/null 2>&1; then
    py_bin="python3"
  elif command -v python >/dev/null 2>&1; then
    py_bin="python"
  else
    return 2
  fi

  "$py_bin" - "$port" <<'PY'
import errno
import socket
import sys

port = int(sys.argv[1])
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
except OSError:
    raise SystemExit(2)
try:
    sock.bind(("127.0.0.1", port))
except OSError as exc:
    if exc.errno in (errno.EADDRINUSE, errno.EACCES):
        raise SystemExit(0)
    raise SystemExit(2)
finally:
    sock.close()

raise SystemExit(1)
PY
}

is_port_in_use() {
  local port="$1"
  local probe_rc=0
  probe_port_with_python "$port" || probe_rc=$?
  if [ "$probe_rc" -eq 0 ]; then
    return 0
  fi
  if [ "$probe_rc" -eq 1 ]; then
    return 1
  fi

  if [ "$HOST_OS" = "windows" ]; then
    netstat -an 2>/dev/null | grep -qE "TCP.*[:.]$port " && return 0
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "(:|^)$port$"
    return $?
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -qE "(:|^)$port$"
    return $?
  fi
  return 1
}

find_available_port() {
  local port="$1"
  local skip="\${2:-}"
  local max_attempts=20
  local attempt=0
  while [ $attempt -lt $max_attempts ]; do
    if [ "$port" != "$skip" ] && ! is_port_in_use "$port"; then
      echo "$port"
      return 0
    fi
    log INFO "Port $port is unavailable, trying next..."
    port=$((port + 1))
    attempt=$((attempt + 1))
  done
  log ERROR "Could not find an available port after $max_attempts attempts (starting from $1)"
  return 1
}

is_running() {
  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  # Fallback: if pid file is stale but the expected listener is alive, treat as running.
  if is_port_in_use "$SOCKS_PORT"; then
    if [ -n "$pid" ]; then
      log WARN "PID $pid is not alive, but port $SOCKS_PORT is in use; recovering runtime state."
    else
      log WARN "No pid file found, but port $SOCKS_PORT is in use; recovering runtime state."
    fi
    return 0
  fi

  if [ -n "$pid" ]; then
    rm -f "$PID_FILE"
  fi
  return 1
}

stop_sslocal() {
  if ! is_running; then
    log INFO "sslocal is not running."
    rm -f "$PID_FILE"
    return 0
  fi

  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
    log OK "Stopped sslocal (pid=$pid)"
    return 0
  fi

  # Fallback for stale / missing pid file: terminate matching processes.
  if command -v pgrep >/dev/null 2>&1; then
    local pids
    pids="$(pgrep -f "$SSLOCAL_BIN" || true)"
    if [ -n "$pids" ]; then
      local spid
      for spid in $pids; do
        kill "$spid" >/dev/null 2>&1 || true
      done
      sleep 1
      pids="$(pgrep -f "$SSLOCAL_BIN" || true)"
      if [ -n "$pids" ]; then
        for spid in $pids; do
          kill -9 "$spid" >/dev/null 2>&1 || true
        done
      fi
      rm -f "$PID_FILE"
      log OK "Stopped sslocal via process scan."
      return 0
    fi
  fi

  rm -f "$PID_FILE"
  log WARN "sslocal was reported running but no managed process could be terminated."
}

is_expected_http_code() {
  local code="$1"
  local token raw
  for raw in $(printf '%s' "$TEST_EXPECTED_HTTP_CODES" | tr ',' ' '); do
    token="$(printf '%s' "$raw" | tr -d '[:space:]')"
    if [ -n "$token" ] && [ "$token" = "$code" ]; then
      return 0
    fi
  done
  return 1
}

write_config_file() {
  if [ -z "$SERVER_INFO_B64" ]; then
    log ERROR "SERVER_INFO_B64 is empty — cannot build config."
    return 10
  fi
  local py_bin
  py_bin="$(find_python)"
  SERVER_INFO_B64="$SERVER_INFO_B64" SOCKS_PORT="$SOCKS_PORT" HTTP_PORT="$HTTP_PORT" \\
    "$py_bin" - "$CFG_FILE" <<'PY'
import base64, json, os, sys

info = json.loads(base64.b64decode(os.environ["SERVER_INFO_B64"]).decode("utf-8"))
socks_port = int(os.environ["SOCKS_PORT"])
http_port = int(os.environ["HTTP_PORT"])
config = {
    "server": info["server"],
    "server_port": int(info["server_port"]),
    "password": info["password"],
    "method": info["method"],
    "locals": [
        {"local_address": "127.0.0.1", "local_port": socks_port, "protocol": "socks"},
        {"local_address": "127.0.0.1", "local_port": http_port, "protocol": "http"},
    ],
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
print(f"[config-written] socks={socks_port} http={http_port}")
PY
}

write_launch_config() {
  local py_bin
  py_bin="$(find_python)"
  "$py_bin" - "$CFG_FILE" "$LAUNCH_CFG_FILE" "$SOCKS_PORT" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
port = int(sys.argv[3])

data = json.loads(source.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit("config root must be a JSON object")

if isinstance(data.get("locals"), list):
    for local in data["locals"]:
        if isinstance(local, dict):
            local["local_address"] = "127.0.0.1"
            local["local_port"] = port
else:
    data["local_address"] = "127.0.0.1"
    data["local_port"] = port

target.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
PY
  log INFO "Prepared launch config with socks=127.0.0.1:$SOCKS_PORT"
}

start_sslocal() {
  install_sslocal
  stop_sslocal >/dev/null 2>&1 || true

  # Auto-detect available SOCKS port
  local actual_socks
  actual_socks="$(find_available_port "$SOCKS_PORT")" || return 1
  if [ "$actual_socks" != "$SOCKS_PORT" ]; then
    log INFO "Configured SOCKS port $SOCKS_PORT is in use. Using $actual_socks instead."
    SOCKS_PORT="$actual_socks"
  fi
  echo "$SOCKS_PORT" > "$SOCKS_PORT_FILE"

  # Auto-detect available HTTP port (skip the one we just claimed for SOCKS)
  local actual_http
  actual_http="$(find_available_port "$HTTP_PORT" "$SOCKS_PORT")" || return 1
  if [ "$actual_http" != "$HTTP_PORT" ]; then
    log INFO "Configured HTTP port $HTTP_PORT is in use. Using $actual_http instead."
    HTTP_PORT="$actual_http"
  fi
  echo "$HTTP_PORT" > "$HTTP_PORT_FILE"
  printf '[actual-ports] socks=%s http=%s\n' "$SOCKS_PORT" "$HTTP_PORT"

  write_config_file

  : > "$LOG_FILE"

  # On Windows, convert MSYS paths to native Windows paths for sslocal.exe
  local cfg_path="$CFG_FILE"
  local log_path="$LOG_FILE"
  if [ "$HOST_OS" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cfg_path="$(cygpath -w "$CFG_FILE")"
    log_path="$(cygpath -w "$LOG_FILE")"
  fi

  nohup "$SSLOCAL_BIN" -c "$cfg_path" >>"$log_path" 2>&1 &

  local pid
  pid="$!"
  if [ "$HOST_OS" = "windows" ]; then
    disown "$pid" 2>/dev/null || true
  fi
  echo "$pid" > "$PID_FILE"
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    log OK "sslocal started (pid=$pid), socks=127.0.0.1:\${SOCKS_PORT}, http=127.0.0.1:\${HTTP_PORT}"
  else
    log ERROR "sslocal failed to start. Last log lines:"
    tail -n 50 "$LOG_FILE" || true
    return 20
  fi
}

set_vscode_proxy() {
  local mode="$1"
  local proxy_url="$2"
  local term_key="$3"   # terminal.integrated.env.<linux|osx|windows>

  local py_bin
  py_bin="$(find_python)"
  PROXY_URL="$proxy_url" PROXY_MODE="$mode" TERM_KEY="$term_key" \\
    "$py_bin" - "$VSCODE_MACHINE_SETTINGS" <<'PY'
import json
import os
import pathlib
import re
import shutil
import sys
import datetime as dt

path = pathlib.Path(sys.argv[1]).expanduser()
mode = os.environ["PROXY_MODE"]
proxy_url = os.environ["PROXY_URL"]
term_key = os.environ["TERM_KEY"]

def strip_jsonc(text: str) -> str:
    result = []
    i = 0
    n = len(text)
    in_string = False
    escape = False
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_string:
            result.append(ch)
            if escape:
                escape = False
            elif ch == "\\\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            result.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            i += 2
            while i < n and text[i] not in "\\r\\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        result.append(ch)
        i += 1
    cleaned = "".join(result)
    return re.sub(r",\\s*([}\\]])", r"\\1", cleaned)

if path.exists():
    raw = path.read_text(encoding="utf-8")
    cleaned = strip_jsonc(raw).strip()
    data = json.loads(cleaned) if cleaned else {}
    if not isinstance(data, dict):
        data = {}
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.{stamp}.bak")
    shutil.copy2(path, backup)
    print(f"[proxy-backup] {backup}")
else:
    data = {}

PROXY_ENV_KEYS = ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy")

before = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}

if mode == "enable":
    data["http.proxy"] = proxy_url
    data["http.proxySupport"] = "on"
    # Also seed terminal env so terminals + child processes inherit the proxy
    term_env = data.get(term_key)
    if not isinstance(term_env, dict):
        term_env = {}
    term_env["HTTPS_PROXY"] = proxy_url
    term_env["HTTP_PROXY"] = proxy_url
    term_env["https_proxy"] = proxy_url
    term_env["http_proxy"] = proxy_url
    term_env["NO_PROXY"] = "localhost,127.0.0.1,::1"
    term_env["no_proxy"] = "localhost,127.0.0.1,::1"
    data[term_key] = term_env
    for k in ("remote.SSH.httpProxy", "remote.SSH.httpsProxy"):
        if k in data:
            del data[k]
else:
    data["http.proxy"] = ""
    data["http.proxySupport"] = "off"
    term_env = data.get(term_key)
    if isinstance(term_env, dict):
        for k in PROXY_ENV_KEYS:
            term_env.pop(k, None)
        if term_env:
            data[term_key] = term_env
        else:
            data.pop(term_key, None)
    for k in ("remote.SSH.httpProxy", "remote.SSH.httpsProxy"):
        if k in data:
            del data[k]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
after = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
    term_key: data.get(term_key, "<unset>"),
}
print(f"[proxy-mode] {mode}")
print(f"[proxy-before] {before}")
print(f"[proxy-after] {after}")
PY
}

write_server_env_setup() {
  # Only applicable to VS Code Server (Remote-SSH host).
  if [ "$IS_VSCODE_SERVER" != "1" ]; then
    log INFO "Skipping server-env-setup (not running under VS Code Server)."
    return 0
  fi
  local proxy_url="$1"
  local marker_begin="# >>> remoteProxy BEGIN <<<"
  local marker_end="# >>> remoteProxy END <<<"

  mkdir -p "$(dirname "$ENV_SETUP_FILE")"
  if [ -f "$ENV_SETUP_FILE" ]; then
    # Strip any prior block managed by us
    local tmp
    tmp="$(mktemp "$TMP_DIR/envsetup.XXXXXX")"
    awk -v b="$marker_begin" -v e="$marker_end" '
      $0==b { inblock=1; next }
      $0==e { inblock=0; next }
      !inblock { print }
    ' "$ENV_SETUP_FILE" > "$tmp"
    mv "$tmp" "$ENV_SETUP_FILE"
  fi

  cat >> "$ENV_SETUP_FILE" <<EOF
$marker_begin
export HTTPS_PROXY="$proxy_url"
export HTTP_PROXY="$proxy_url"
export https_proxy="$proxy_url"
export http_proxy="$proxy_url"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"
$marker_end
EOF
  log OK "Wrote proxy env to $ENV_SETUP_FILE"
  log INFO "To apply: run 'Remote-SSH: Kill VS Code Server on Host', then reconnect."
}

clear_server_env_setup() {
  if [ ! -f "$ENV_SETUP_FILE" ]; then
    return 0
  fi
  local marker_begin="# >>> remoteProxy BEGIN <<<"
  local marker_end="# >>> remoteProxy END <<<"
  local tmp
  tmp="$(mktemp "$TMP_DIR/envsetup.XXXXXX")"
  awk -v b="$marker_begin" -v e="$marker_end" '
    $0==b { inblock=1; next }
    $0==e { inblock=0; next }
    !inblock { print }
  ' "$ENV_SETUP_FILE" > "$tmp"
  mv "$tmp" "$ENV_SETUP_FILE"
  # Remove file if it's now empty / whitespace-only
  if [ ! -s "$ENV_SETUP_FILE" ] || [ -z "$(tr -d '[:space:]' < "$ENV_SETUP_FILE")" ]; then
    rm -f "$ENV_SETUP_FILE"
  fi
  log OK "Cleared proxy env block from $ENV_SETUP_FILE"
}

terminal_env_key() {
  case "$HOST_OS" in
    windows) echo "terminal.integrated.env.windows" ;;
    macos)   echo "terminal.integrated.env.osx" ;;
    *)       echo "terminal.integrated.env.linux" ;;
  esac
}

# Wrap the Anthropic Claude Code bundled 'claude' native binary so it inherits
# proxy env. The extension host spawns this child with a stripped environment,
# bypassing HTTPS_PROXY. We rename the real binary to claude.real and replace
# it with a bash shim that re-exports proxy env from $PROXY_URL_FILE before
# exec'ing the real binary.
wrap_claude_code() {
  if [ "$WRAP_CLAUDE_CODE" != "1" ]; then
    log INFO "Claude Code auto-wrap disabled (WRAP_CLAUDE_CODE=$WRAP_CLAUDE_CODE)."
    return 0
  fi
  if [ "$HOST_OS" = "windows" ]; then
    log INFO "Skipping Claude Code wrap on Windows."
    return 0
  fi
  if [ ! -d "$VSCODE_EXT_ROOT" ]; then
    log INFO "VS Code extensions dir not found: $VSCODE_EXT_ROOT — skipping Claude Code wrap."
    return 0
  fi
  local proxy_url="$1"
  echo "$proxy_url" > "$PROXY_URL_FILE"

  local wrapped_count=0
  local skipped_count=0
  local d bin_path real_path
  # Match -linux-x64, -linux-arm64, -darwin-x64, -darwin-arm64, etc.
  for d in "$VSCODE_EXT_ROOT"/anthropic.claude-code-*; do
    [ -d "$d" ] || continue
    bin_path="$d/resources/native-binary/claude"
    [ -f "$bin_path" ] || continue
    real_path="$d/resources/native-binary/claude.real"

    if [ -f "$real_path" ] && grep -q "remoteProxy-wrapper" "$bin_path" 2>/dev/null; then
      log INFO "Claude Code already wrapped: $bin_path"
      skipped_count=$((skipped_count + 1))
      continue
    fi

    # If real_path doesn't exist yet, move the original out of the way
    if [ ! -f "$real_path" ]; then
      mv "$bin_path" "$real_path"
    else
      # real_path exists but bin_path is not our wrapper — back up bin_path and
      # use the saved real_path
      rm -f "$bin_path"
    fi

    cat > "$bin_path" <<'WRAPEOF'
#!/usr/bin/env bash
# remoteProxy-wrapper: injected by remote-ss-proxy-controller
SS_PROXY_STATE="$HOME/.extensions-ssproxy/state/proxy_url"
if [ -f "$SS_PROXY_STATE" ]; then
  PROXY_URL="$(cat "$SS_PROXY_STATE" 2>/dev/null || true)"
  if [ -n "$PROXY_URL" ]; then
    export HTTPS_PROXY="$PROXY_URL"
    export HTTP_PROXY="$PROXY_URL"
    export https_proxy="$PROXY_URL"
    export http_proxy="$PROXY_URL"
    export NO_PROXY="\${NO_PROXY:-localhost,127.0.0.1,::1,.svc,.cluster.local}"
    export no_proxy="$NO_PROXY"
  fi
fi
exec "$(dirname "$0")/claude.real" "$@"
WRAPEOF
    chmod +x "$bin_path"
    log OK "Wrapped Claude Code binary: $bin_path"
    wrapped_count=$((wrapped_count + 1))
  done

  if [ "$wrapped_count" = "0" ] && [ "$skipped_count" = "0" ]; then
    log INFO "No anthropic.claude-code-* extension found under $VSCODE_EXT_ROOT."
  else
    log OK "Claude Code wrap: $wrapped_count wrapped, $skipped_count already wrapped."
  fi
}

unwrap_claude_code() {
  if [ "$HOST_OS" = "windows" ]; then
    return 0
  fi
  if [ ! -d "$VSCODE_EXT_ROOT" ]; then
    return 0
  fi
  local unwrapped_count=0
  local d bin_path real_path
  for d in "$VSCODE_EXT_ROOT"/anthropic.claude-code-*; do
    [ -d "$d" ] || continue
    bin_path="$d/resources/native-binary/claude"
    real_path="$d/resources/native-binary/claude.real"
    [ -f "$real_path" ] || continue

    # Only unwrap if bin_path is our shim
    if [ -f "$bin_path" ] && grep -q "remoteProxy-wrapper" "$bin_path" 2>/dev/null; then
      rm -f "$bin_path"
      mv "$real_path" "$bin_path"
      chmod +x "$bin_path"
      log OK "Unwrapped Claude Code binary: $bin_path"
      unwrapped_count=$((unwrapped_count + 1))
    fi
  done
  rm -f "$PROXY_URL_FILE"
  if [ "$unwrapped_count" = "0" ]; then
    log INFO "No wrapped Claude Code binaries found to restore."
  fi
}

show_proxy_state() {
  local py_bin
  py_bin="$(find_python)"
  "$py_bin" - "$VSCODE_MACHINE_SETTINGS" <<'PY'
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1]).expanduser()
if not path.exists():
    print("[proxy-state] settings file not found")
    raise SystemExit(0)

raw = path.read_text(encoding="utf-8")

def strip_jsonc(text: str) -> str:
    result = []
    i = 0
    n = len(text)
    in_string = False
    escape = False
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_string:
            result.append(ch)
            if escape:
                escape = False
            elif ch == "\\\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            result.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            i += 2
            while i < n and text[i] not in "\\r\\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        result.append(ch)
        i += 1
    return re.sub(r",\\s*([}\\]])", r"\\1", "".join(result))

cleaned = strip_jsonc(raw).strip()
data = json.loads(cleaned) if cleaned else {}
if not isinstance(data, dict):
    data = {}

vals = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}
print(f"[proxy-state] {vals}")
PY
}

status_sslocal() {
  if is_running; then
    local pid=""
    if [ -f "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    fi
    if [ -n "$pid" ]; then
      log OK "sslocal is running (pid=$pid), socks=127.0.0.1:\${SOCKS_PORT}, http=127.0.0.1:\${HTTP_PORT}"
    else
      log OK "sslocal appears to be running (pid unavailable), socks=127.0.0.1:\${SOCKS_PORT}, http=127.0.0.1:\${HTTP_PORT}"
    fi
  else
    log INFO "sslocal is not running."
  fi

  show_proxy_state

  if [ -f "$ENV_SETUP_FILE" ]; then
    if grep -q "remoteProxy BEGIN" "$ENV_SETUP_FILE" 2>/dev/null; then
      log OK "server-env-setup contains proxy block."
    else
      log INFO "server-env-setup exists but has no proxy block."
    fi
  else
    log INFO "server-env-setup not present."
  fi

  if [ -f "$LOG_FILE" ]; then
    log INFO "Last \${TAIL_LINES} proxy log lines:"
    tail -n "$TAIL_LINES" "$LOG_FILE" || true
  fi
}

test_proxy() {
  if ! is_running; then
    log ERROR "Proxy test aborted: sslocal is not running."
    return 30
  fi

  log INFO "Expected HTTP codes: $TEST_EXPECTED_HTTP_CODES"

  _test_proxy_one() {
    local label="$1"
    local mode="$2"      # "socks" or "http"
    local rc=0
    local attempt=1
    local max_attempts=3
    local http_code=""

    while [ "$attempt" -le "$max_attempts" ]; do
      log INFO "Testing $label proxy: $TEST_URL (attempt $attempt/$max_attempts)"
      set +e
      if [ "$mode" = "socks" ]; then
        http_code="$(curl -sS -o /dev/null -w "%{http_code}" \\
          --connect-timeout 12 --max-time 20 --retry 2 --retry-connrefused --retry-delay 1 \\
          --socks5-hostname "127.0.0.1:\${SOCKS_PORT}" "$TEST_URL")"
      else
        http_code="$(curl -sS -o /dev/null -w "%{http_code}" \\
          --connect-timeout 12 --max-time 20 --retry 2 --retry-connrefused --retry-delay 1 \\
          --proxy "http://127.0.0.1:\${HTTP_PORT}" "$TEST_URL")"
      fi
      rc=$?
      set -e
      if [ $rc -eq 0 ] && [ "$http_code" != "000" ]; then
        log INFO "\${label}_http_code=$http_code"
        if is_expected_http_code "$http_code"; then
          return 0
        fi
        log WARN "$label HTTP code $http_code is not in expected set ($TEST_EXPECTED_HTTP_CODES)."
        rc=41
      elif [ -n "$http_code" ]; then
        log INFO "\${label}_http_code=$http_code"
      fi
      log WARN "$label proxy test curl failed (rc=$rc) on attempt $attempt/$max_attempts."
      [ "$attempt" -lt "$max_attempts" ] && sleep 1
      attempt=$((attempt + 1))
    done
    log ERROR "$label proxy test failed after $max_attempts attempts (last rc=$rc)."
    return $rc
  }

  if ! _test_proxy_one "socks" "socks"; then
    log INFO "Recent sslocal log tail for diagnostics:"
    tail -n 30 "$LOG_FILE" 2>/dev/null || true
    return 40
  fi
  if ! _test_proxy_one "http" "http"; then
    log INFO "Recent sslocal log tail for diagnostics:"
    tail -n 30 "$LOG_FILE" 2>/dev/null || true
    return 41
  fi
  log OK "Proxy tests completed (socks + http)."
}

show_logs() {
  if [ -f "$LOG_FILE" ]; then
    log INFO "Showing last \${TAIL_LINES} lines from $LOG_FILE"
    tail -n "$TAIL_LINES" "$LOG_FILE"
  else
    log INFO "Log file not found: $LOG_FILE"
  fi
}

case "$ACTION" in
  install)
    install_sslocal
    ;;
  up)
    start_sslocal
    TERM_KEY="$(terminal_env_key)"
    PROXY_URL="http://127.0.0.1:\${HTTP_PORT}"
    set_vscode_proxy enable "$PROXY_URL" "$TERM_KEY"
    write_server_env_setup "$PROXY_URL"
    wrap_claude_code "$PROXY_URL"
    test_proxy
    status_sslocal
    ;;
  down)
    stop_sslocal
    TERM_KEY="$(terminal_env_key)"
    set_vscode_proxy disable "" "$TERM_KEY"
    clear_server_env_setup
    unwrap_claude_code
    status_sslocal
    ;;
  status)
    status_sslocal
    ;;
  test)
    test_proxy
    status_sslocal
    ;;
  logs)
    show_logs
    ;;
  *)
    log ERROR "Unknown ACTION=$ACTION"
    exit 1
    ;;
esac
`;

// ---------------------------------------------------------------------------
// Revert / rollback script
// ---------------------------------------------------------------------------
export const REVERT_REMOTE_SCRIPT = `set -euo pipefail

SOCKS_PORT="\${SOCKS_PORT:-1080}"
HTTP_PORT="\${HTTP_PORT:-1081}"
TAIL_LINES="\${TAIL_LINES:-80}"
REMOVE_ALL_STATE="\${REMOVE_ALL_STATE:-0}"

BASE_DIR="$HOME/.extensions-ssproxy"
BIN_DIR="$BASE_DIR/bin"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/log"
TMP_DIR="$BASE_DIR/tmp"
PID_FILE="$STATE_DIR/sslocal.pid"
CFG_FILE="$STATE_DIR/config.json"
LAUNCH_CFG_FILE="$STATE_DIR/launch_config.json"
LOG_FILE="$LOG_DIR/sslocal.log"
SSLOCAL_BIN="$BIN_DIR/sslocal"
SOCKS_PORT_FILE="$STATE_DIR/socks_port"
HTTP_PORT_FILE="$STATE_DIR/http_port"
PROXY_URL_FILE="$STATE_DIR/proxy_url"
ENV_SETUP_FILE="$HOME/.vscode-server/server-env-setup"

# Detect host OS for cross-platform support
HOST_OS="linux"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
  Darwin) HOST_OS="macos" ;;
esac

if [ "$HOST_OS" = "windows" ]; then
  SSLOCAL_BIN="$BIN_DIR/sslocal.exe"
fi

IS_VSCODE_SERVER=0
if [ -d "$HOME/.vscode-server" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/.vscode-server/data/Machine/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode-server/extensions"
  IS_VSCODE_SERVER=1
elif [ "$HOST_OS" = "macos" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode/extensions"
elif [ "$HOST_OS" = "windows" ]; then
  VSCODE_MACHINE_SETTINGS="$APPDATA/Code/User/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode/extensions"
else
  VSCODE_MACHINE_SETTINGS="$HOME/.config/Code/User/settings.json"
  VSCODE_EXT_ROOT="$HOME/.vscode/extensions"
fi

mkdir -p "$TMP_DIR"

# Read stored ports if available
if [ -f "$SOCKS_PORT_FILE" ]; then
  sp="$(cat "$SOCKS_PORT_FILE" 2>/dev/null || true)"
  [ -n "$sp" ] && SOCKS_PORT="$sp"
fi
if [ -f "$HTTP_PORT_FILE" ]; then
  hp="$(cat "$HTTP_PORT_FILE" 2>/dev/null || true)"
  [ -n "$hp" ] && HTTP_PORT="$hp"
fi

log() {
  # Write to stdout (not stderr): some SSH setups buffer/swallow stderr until
  # process exit, hiding all [OK]/[INFO] log lines from the extension's output
  # channel. stdout is reliably streamed line-by-line.
  printf '[%s][%s] %s\\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$1" "$2"
}

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
  elif command -v python >/dev/null 2>&1; then
    echo "python"
  else
    log ERROR "python3 (or python) is required but not found."
    return 1
  fi
}

kill_known_pid() {
  if [ ! -f "$PID_FILE" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    log OK "Stopped sslocal from pid file (pid=$pid)"
  fi
  rm -f "$PID_FILE"
}

kill_stray_processes() {
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids="$(pgrep -f "$SSLOCAL_BIN" || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  sleep 1
  pids="$(pgrep -f "$SSLOCAL_BIN" || true)"
  if [ -n "$pids" ]; then
    for pid in $pids; do
      kill -9 "$pid" >/dev/null 2>&1 || true
    done
  fi
  log OK "Killed stray sslocal process(es)."
}

terminal_env_key() {
  case "$HOST_OS" in
    windows) echo "terminal.integrated.env.windows" ;;
    macos)   echo "terminal.integrated.env.osx" ;;
    *)       echo "terminal.integrated.env.linux" ;;
  esac
}

set_vscode_proxy_disable() {
  local term_key="$1"
  local py_bin
  py_bin="$(find_python)"
  TERM_KEY="$term_key" "$py_bin" - "$VSCODE_MACHINE_SETTINGS" <<'PY'
import json
import os
import pathlib
import re
import shutil
import sys
import datetime as dt

path = pathlib.Path(sys.argv[1]).expanduser()
term_key = os.environ["TERM_KEY"]

def strip_jsonc(text: str) -> str:
    result = []
    i = 0
    n = len(text)
    in_string = False
    escape = False
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_string:
            result.append(ch)
            if escape:
                escape = False
            elif ch == "\\\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            result.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            i += 2
            while i < n and text[i] not in "\\r\\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        result.append(ch)
        i += 1
    return re.sub(r",\\s*([}\\]])", r"\\1", "".join(result))

if path.exists():
    raw = path.read_text(encoding="utf-8")
    cleaned = strip_jsonc(raw).strip()
    data = json.loads(cleaned) if cleaned else {}
    if not isinstance(data, dict):
        data = {}
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.{stamp}.bak")
    shutil.copy2(path, backup)
    print(f"[proxy-backup] {backup}")
else:
    data = {}

PROXY_ENV_KEYS = ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy")

before = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}

data["http.proxy"] = ""
data["http.proxySupport"] = "off"
term_env = data.get(term_key)
if isinstance(term_env, dict):
    for k in PROXY_ENV_KEYS:
        term_env.pop(k, None)
    if term_env:
        data[term_key] = term_env
    else:
        data.pop(term_key, None)
for k in ("remote.SSH.httpProxy", "remote.SSH.httpsProxy"):
    if k in data:
        del data[k]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
after = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
    term_key: data.get(term_key, "<unset>"),
}
print("[proxy-mode] disable")
print(f"[proxy-before] {before}")
print(f"[proxy-after] {after}")
PY
}

clear_server_env_setup() {
  if [ ! -f "$ENV_SETUP_FILE" ]; then
    return 0
  fi
  local marker_begin="# >>> remoteProxy BEGIN <<<"
  local marker_end="# >>> remoteProxy END <<<"
  local tmp
  tmp="$(mktemp "$TMP_DIR/envsetup.XXXXXX")"
  awk -v b="$marker_begin" -v e="$marker_end" '
    $0==b { inblock=1; next }
    $0==e { inblock=0; next }
    !inblock { print }
  ' "$ENV_SETUP_FILE" > "$tmp"
  mv "$tmp" "$ENV_SETUP_FILE"
  if [ ! -s "$ENV_SETUP_FILE" ] || [ -z "$(tr -d '[:space:]' < "$ENV_SETUP_FILE")" ]; then
    rm -f "$ENV_SETUP_FILE"
  fi
  log OK "Cleared proxy env block from $ENV_SETUP_FILE"
}

unwrap_claude_code() {
  if [ "$HOST_OS" = "windows" ]; then
    return 0
  fi
  if [ ! -d "$VSCODE_EXT_ROOT" ]; then
    return 0
  fi
  local unwrapped_count=0
  local d bin_path real_path
  for d in "$VSCODE_EXT_ROOT"/anthropic.claude-code-*; do
    [ -d "$d" ] || continue
    bin_path="$d/resources/native-binary/claude"
    real_path="$d/resources/native-binary/claude.real"
    [ -f "$real_path" ] || continue
    if [ -f "$bin_path" ] && grep -q "remoteProxy-wrapper" "$bin_path" 2>/dev/null; then
      rm -f "$bin_path"
      mv "$real_path" "$bin_path"
      chmod +x "$bin_path"
      log OK "Unwrapped Claude Code binary: $bin_path"
      unwrapped_count=$((unwrapped_count + 1))
    fi
  done
  rm -f "$PROXY_URL_FILE"
  if [ "$unwrapped_count" = "0" ]; then
    log INFO "No wrapped Claude Code binaries found to restore."
  fi
}

show_status() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log WARN "sslocal still appears running (pid=$pid)"
    else
      log OK "sslocal is not running."
    fi
  else
    log OK "sslocal is not running."
  fi

  if [ -f "$SSLOCAL_BIN" ]; then
    log WARN "sslocal binary still exists: $SSLOCAL_BIN"
  else
    log OK "sslocal binary removed."
  fi

  if [ -f "$LOG_FILE" ]; then
    log INFO "Last \${TAIL_LINES} proxy log lines:"
    tail -n "$TAIL_LINES" "$LOG_FILE" || true
  fi
}

kill_known_pid
kill_stray_processes
TERM_KEY="$(terminal_env_key)"
set_vscode_proxy_disable "$TERM_KEY"
clear_server_env_setup
unwrap_claude_code

rm -f "$SSLOCAL_BIN" "$CFG_FILE" "$LAUNCH_CFG_FILE" "$SOCKS_PORT_FILE" "$HTTP_PORT_FILE" "$PROXY_URL_FILE" >/dev/null 2>&1 || true

if [ "$REMOVE_ALL_STATE" = "1" ]; then
  rm -rf "$BASE_DIR" >/dev/null 2>&1 || true
  log OK "Removed $BASE_DIR"
else
  log INFO "Preserved runtime directories under $BASE_DIR (pass -RemoveAllState to delete them)."
fi

show_status
`;
