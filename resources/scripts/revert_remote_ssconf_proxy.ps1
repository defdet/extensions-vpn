param(
    [string]$SshHost = "gpu_polymer_2",
    [int]$SocksPort = 1080,
    [switch]$RemoveAllState,
    [string]$LogTailLines = "80"
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param(
        [ValidateSet("INFO", "WARN", "ERROR", "OK")]
        [string]$Level,
        [string]$Message
    )
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts][$Level] $Message"
}

function Resolve-SshExe {
    $preferred = "C:\Windows\System32\OpenSSH\ssh.exe"
    if (Test-Path -LiteralPath $preferred) {
        return $preferred
    }

    $cmd = Get-Command ssh -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
        return $cmd.Source
    }

    throw "ssh executable not found."
}

if ($SocksPort -lt 1 -or $SocksPort -gt 65535) {
    throw "SocksPort must be in range 1..65535"
}

$sshExe = Resolve-SshExe

$remoteScript = @'
set -euo pipefail

SOCKS_PORT="${SOCKS_PORT:-1080}"
TAIL_LINES="${TAIL_LINES:-80}"
REMOVE_ALL_STATE="${REMOVE_ALL_STATE:-0}"

BASE_DIR="$HOME/.codex-ssproxy"
BIN_DIR="$BASE_DIR/bin"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/log"
PID_FILE="$STATE_DIR/sslocal.pid"
MODE_FILE="$STATE_DIR/mode"
URL_FILE="$STATE_DIR/server_url.txt"
CFG_FILE="$STATE_DIR/config.json"
LOG_FILE="$LOG_DIR/sslocal.log"
SSLOCAL_BIN="$BIN_DIR/sslocal"
VSCODE_MACHINE_SETTINGS="$HOME/.vscode-server/data/Machine/settings.json"

log() {
  printf '[%s][%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$1" "$2"
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
  if ps -p "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if ps -p "$pid" >/dev/null 2>&1; then
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
  python3 - "$VSCODE_MACHINE_SETTINGS" <<'PY'
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
            elif ch == "\\":
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
            while i < n and text[i] not in "\r\n":
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
    return re.sub(r",\s*([}\]])", r"\1", "".join(result))

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
path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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
    if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
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
    log INFO "Last ${TAIL_LINES} proxy log lines:"
    tail -n "$TAIL_LINES" "$LOG_FILE" || true
  fi
}

kill_known_pid
kill_stray_processes
set_vscode_proxy_disable

rm -f "$SSLOCAL_BIN" "$MODE_FILE" "$URL_FILE" "$CFG_FILE" >/dev/null 2>&1 || true

if [ "$REMOVE_ALL_STATE" = "1" ]; then
  rm -rf "$BASE_DIR" >/dev/null 2>&1 || true
  log OK "Removed $BASE_DIR"
else
  log INFO "Preserved runtime directories under $BASE_DIR (pass -RemoveAllState to delete them)."
fi

show_status
'@

$remoteScript = $remoteScript -replace "`r", ""
$removeAllStateFlag = if ($RemoveAllState) { "1" } else { "0" }
$remoteCommand = "tr -d '\r' | SOCKS_PORT='$SocksPort' TAIL_LINES='$LogTailLines' REMOVE_ALL_STATE='$removeAllStateFlag' bash -s"

Write-Log -Level INFO -Message ("Running rollback on " + $SshHost + " ...")
$remoteOutput = $remoteScript | & $sshExe $SshHost $remoteCommand 2>&1
$remoteExit = $LASTEXITCODE
if ($null -ne $remoteOutput) {
    $remoteOutput | ForEach-Object { Write-Host $_ }
}
if ($remoteExit -ne 0) {
    throw "Remote rollback failed with exit code $remoteExit"
}

Write-Log -Level OK -Message "Rollback complete. Reconnect VS Code remote if needed."
