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
SS_VERSION="\${SS_VERSION:-v1.24.0}"
RUNTIME_MODE="\${RUNTIME_MODE:-}"
SERVER_URL_B64="\${SERVER_URL_B64:-}"
CONFIG_B64="\${CONFIG_B64:-}"
TEST_URL="\${TEST_URL:-https://api.openai.com/v1/models}"
TAIL_LINES="\${TAIL_LINES:-80}"

BASE_DIR="$HOME/.extensions-ssproxy"
BIN_DIR="$BASE_DIR/bin"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/log"
TMP_DIR="$BASE_DIR/tmp"
PID_FILE="$STATE_DIR/sslocal.pid"
MODE_FILE="$STATE_DIR/mode"
URL_FILE="$STATE_DIR/server_url.txt"
CFG_FILE="$STATE_DIR/config.json"
LAUNCH_CFG_FILE="$STATE_DIR/launch_config.json"
LOG_FILE="$LOG_DIR/sslocal.log"
PORT_FILE="$STATE_DIR/port"

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
if [ -d "$HOME/.vscode-server" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/.vscode-server/data/Machine/settings.json"
elif [ "$HOST_OS" = "macos" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
elif [ "$HOST_OS" = "windows" ]; then
  VSCODE_MACHINE_SETTINGS="$APPDATA/Code/User/settings.json"
else
  VSCODE_MACHINE_SETTINGS="$HOME/.config/Code/User/settings.json"
fi

mkdir -p "$BIN_DIR" "$STATE_DIR" "$LOG_DIR" "$TMP_DIR"
mkdir -p "$(dirname "$VSCODE_MACHINE_SETTINGS")"

# For non-up actions, read the stored port so status/test/logs use the right one
if [ "$ACTION" != "up" ] && [ -f "$PORT_FILE" ]; then
  stored_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
  if [ -n "$stored_port" ]; then
    SOCKS_PORT="$stored_port"
  fi
fi

log() {
  printf '[%s][%s] %s\\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$1" "$2" >&2
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
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
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
    # Windows netstat output format: "  TCP    0.0.0.0:1080  ..."
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
  local max_attempts=20
  local attempt=0
  while [ $attempt -lt $max_attempts ]; do
    if ! is_port_in_use "$port"; then
      echo "$port"
      return 0
    fi
    log INFO "Port $port is already in use, trying next..."
    port=$((port + 1))
    attempt=$((attempt + 1))
  done
  log ERROR "Could not find an available port after $max_attempts attempts (starting from $1)"
  return 1
}

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

stop_sslocal() {
  if ! is_running; then
    log INFO "sslocal is not running."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  log OK "Stopped sslocal (pid=$pid)"
}

write_runtime_files() {
  if [ "$RUNTIME_MODE" = "server_url" ]; then
    if [ -z "$SERVER_URL_B64" ]; then
      log ERROR "RUNTIME_MODE=server_url but SERVER_URL_B64 is empty."
      return 10
    fi
    printf '%s' "$SERVER_URL_B64" | base64 -d > "$URL_FILE"
    printf 'server_url\\n' > "$MODE_FILE"
    log INFO "Stored runtime mode: server_url"
    return 0
  fi

  if [ "$RUNTIME_MODE" = "config" ]; then
    if [ -z "$CONFIG_B64" ]; then
      log ERROR "RUNTIME_MODE=config but CONFIG_B64 is empty."
      return 11
    fi
    printf '%s' "$CONFIG_B64" | base64 -d > "$CFG_FILE"
    printf 'config\\n' > "$MODE_FILE"
    log INFO "Stored runtime mode: config"
    return 0
  fi

  log ERROR "Missing or unsupported RUNTIME_MODE. Expected server_url or config."
  return 12
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
  write_runtime_files
  stop_sslocal >/dev/null 2>&1 || true

  # Auto-detect available port
  local actual_port
  actual_port="$(find_available_port "$SOCKS_PORT")" || return 1
  if [ "$actual_port" != "$SOCKS_PORT" ]; then
    log INFO "Configured port $SOCKS_PORT is in use. Using port $actual_port instead."
    SOCKS_PORT="$actual_port"
  fi
  echo "$SOCKS_PORT" > "$PORT_FILE"
  printf '[actual-port] %s\n' "$SOCKS_PORT"

  local mode
  mode="$(cat "$MODE_FILE")"
  : > "$LOG_FILE"

  if [ "$mode" = "config" ]; then
    write_launch_config
  fi

  # On Windows, convert MSYS paths to native Windows paths for the sslocal.exe binary
  local cfg_path="$LAUNCH_CFG_FILE"
  local log_path="$LOG_FILE"
  if [ "$HOST_OS" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cfg_path="$(cygpath -w "$LAUNCH_CFG_FILE")"
    log_path="$(cygpath -w "$LOG_FILE")"
  fi

  if [ "$mode" = "server_url" ]; then
    local server_url
    server_url="$(cat "$URL_FILE")"
    nohup "$SSLOCAL_BIN" -b "127.0.0.1:\${SOCKS_PORT}" --server-url "$server_url" >>"$log_path" 2>&1 &
  else
    nohup "$SSLOCAL_BIN" -c "$cfg_path" >>"$log_path" 2>&1 &
  fi

  local pid
  pid="$!"
  # On Windows (Git Bash), disown prevents SIGHUP on bash exit
  if [ "$HOST_OS" = "windows" ]; then
    disown "$pid" 2>/dev/null || true
  fi
  echo "$pid" > "$PID_FILE"
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    log OK "sslocal started (pid=$pid), socks=127.0.0.1:\${SOCKS_PORT}"
  else
    log ERROR "sslocal failed to start. Last log lines:"
    tail -n 50 "$LOG_FILE" || true
    return 20
  fi
}

set_vscode_proxy() {
  local mode="$1"
  local proxy_url="$2"

  local py_bin
  py_bin="$(find_python)"
  "$py_bin" - "$VSCODE_MACHINE_SETTINGS" "$mode" "$proxy_url" <<'PY'
import json
import pathlib
import re
import shutil
import sys
import datetime as dt

path = pathlib.Path(sys.argv[1]).expanduser()
mode = sys.argv[2]
proxy_url = sys.argv[3]

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

before = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}

if mode == "enable":
    data["http.proxy"] = proxy_url
    data["http.proxySupport"] = "on"
    for k in ("remote.SSH.httpProxy", "remote.SSH.httpsProxy"):
        if k in data:
            del data[k]
else:
    data["http.proxy"] = ""
    data["http.proxySupport"] = "off"
    for k in ("remote.SSH.httpProxy", "remote.SSH.httpsProxy"):
        if k in data:
            del data[k]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
after = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}
print(f"[proxy-mode] {mode}")
print(f"[proxy-before] {before}")
print(f"[proxy-after] {after}")
PY
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
    local pid
    pid="$(cat "$PID_FILE")"
    log OK "sslocal is running (pid=$pid)"
  else
    log INFO "sslocal is not running."
  fi

  show_proxy_state

  if [ -f "$LOG_FILE" ]; then
    log INFO "Last \${TAIL_LINES} proxy log lines:"
    tail -n "$TAIL_LINES" "$LOG_FILE" || true
  fi
}

test_proxy() {
  local rc
  log INFO "Testing proxy with curl via socks5-hostname: $TEST_URL"
  set +e
  curl -sS -o /dev/null -w "http_code=%{http_code}\\n" --connect-timeout 12 --socks5-hostname "127.0.0.1:\${SOCKS_PORT}" "$TEST_URL"
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    log ERROR "Proxy test curl failed (rc=$rc)"
    return $rc
  fi
  log OK "Proxy test command completed."
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
    set_vscode_proxy enable "socks5://127.0.0.1:\${SOCKS_PORT}"
    test_proxy
    status_sslocal
    ;;
  down)
    stop_sslocal
    set_vscode_proxy disable "socks5://127.0.0.1:\${SOCKS_PORT}"
    status_sslocal
    ;;
  status)
    status_sslocal
    ;;
  test)
    test_proxy
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
TAIL_LINES="\${TAIL_LINES:-80}"
REMOVE_ALL_STATE="\${REMOVE_ALL_STATE:-0}"

BASE_DIR="$HOME/.extensions-ssproxy"
BIN_DIR="$BASE_DIR/bin"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/log"
PID_FILE="$STATE_DIR/sslocal.pid"
MODE_FILE="$STATE_DIR/mode"
URL_FILE="$STATE_DIR/server_url.txt"
CFG_FILE="$STATE_DIR/config.json"
LAUNCH_CFG_FILE="$STATE_DIR/launch_config.json"
LOG_FILE="$LOG_DIR/sslocal.log"
SSLOCAL_BIN="$BIN_DIR/sslocal"
PORT_FILE="$STATE_DIR/port"

# Detect host OS for cross-platform support
HOST_OS="linux"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
  Darwin) HOST_OS="macos" ;;
esac

# Set binary name based on OS
if [ "$HOST_OS" = "windows" ]; then
  SSLOCAL_BIN="$BIN_DIR/sslocal.exe"
fi

# Auto-detect VS Code settings path: remote (.vscode-server) vs local
if [ -d "$HOME/.vscode-server" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/.vscode-server/data/Machine/settings.json"
elif [ "$HOST_OS" = "macos" ]; then
  VSCODE_MACHINE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
elif [ "$HOST_OS" = "windows" ]; then
  VSCODE_MACHINE_SETTINGS="$APPDATA/Code/User/settings.json"
else
  VSCODE_MACHINE_SETTINGS="$HOME/.config/Code/User/settings.json"
fi

# Read the stored port if available
if [ -f "$PORT_FILE" ]; then
  stored_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
  if [ -n "$stored_port" ]; then
    SOCKS_PORT="$stored_port"
  fi
fi

log() {
  printf '[%s][%s] %s\\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$1" "$2" >&2
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

set_vscode_proxy_disable() {
  local py_bin
  py_bin="$(find_python)"
  "$py_bin" - "$VSCODE_MACHINE_SETTINGS" <<'PY'
import json
import pathlib
import re
import shutil
import sys
import datetime as dt

path = pathlib.Path(sys.argv[1]).expanduser()

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

before = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}

data["http.proxy"] = ""
data["http.proxySupport"] = "off"
for k in ("remote.SSH.httpProxy", "remote.SSH.httpsProxy"):
    if k in data:
        del data[k]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
after = {
    "http.proxy": data.get("http.proxy", "<unset>"),
    "http.proxySupport": data.get("http.proxySupport", "<unset>"),
}
print("[proxy-mode] disable")
print(f"[proxy-before] {before}")
print(f"[proxy-after] {after}")
PY
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
set_vscode_proxy_disable

rm -f "$SSLOCAL_BIN" "$MODE_FILE" "$URL_FILE" "$CFG_FILE" "$LAUNCH_CFG_FILE" "$PORT_FILE" >/dev/null 2>&1 || true

if [ "$REMOVE_ALL_STATE" = "1" ]; then
  rm -rf "$BASE_DIR" >/dev/null 2>&1 || true
  log OK "Removed $BASE_DIR"
else
  log INFO "Preserved runtime directories under $BASE_DIR (pass -RemoveAllState to delete them)."
fi

show_status
`;
