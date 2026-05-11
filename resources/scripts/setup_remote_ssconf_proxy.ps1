param(
    [string]$SshHost = "gpu_polymer_2",
    [ValidateSet("up", "down", "status", "test", "logs", "install")]
    [string]$Action = "up",
    [string]$AccessKey = "",
    [int]$SocksPort = 1080,
    [string]$ShadowsocksVersion = "v1.24.0",
    [string]$TestUrl = "https://api.openai.com/v1/models",
    [switch]$SkipLocalCodexWorkspace,
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

function Encode-Base64Utf8 {
    param([string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    return [Convert]::ToBase64String($bytes)
}

function Get-UrlBody {
    param([string]$Url)
    $body = & curl.exe -fsSL --connect-timeout 20 $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch URL: $Url"
    }
    return [string]$body
}

function Parse-Endpoint {
    param([string]$Endpoint)

    $ep = $Endpoint.Trim()
    if ($ep.StartsWith("[") -and $ep.Contains("]:")) {
        $idx = $ep.LastIndexOf("]:")
        $host = $ep.Substring(1, $idx - 1)
        $port = [int]$ep.Substring($idx + 2)
        return @{ Host = $host; Port = $port }
    }

    $parts = $ep.Split(":")
    if ($parts.Length -lt 2) {
        throw "Endpoint does not include host:port: $Endpoint"
    }

    $port = [int]$parts[$parts.Length - 1]
    $host = ($parts[0..($parts.Length - 2)] -join ":")
    return @{ Host = $host; Port = $port }
}

function Parse-YamlLikePayload {
    param([string]$Payload)

    $endpoint = $null
    $cipher = $null
    $secret = $null
    foreach ($line in ($Payload -split "`r?`n")) {
        $s = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($s) -or $s.StartsWith("#")) {
            continue
        }
        if ($null -eq $endpoint -and $s -match '^endpoint:\s*([^\s#]+)') {
            $endpoint = $Matches[1]
            continue
        }
        if ($null -eq $cipher -and $s -match '^cipher:\s*([^\s#]+)') {
            $cipher = $Matches[1]
            continue
        }
        if ($null -eq $secret -and $s -match '^secret:\s*(.+)$') {
            $secret = $Matches[1].Trim()
            if (($secret.StartsWith('"') -and $secret.EndsWith('"')) -or ($secret.StartsWith("'") -and $secret.EndsWith("'"))) {
                $secret = $secret.Substring(1, $secret.Length - 2)
            }
            continue
        }
    }

    if ($null -eq $endpoint -or $null -eq $cipher -or $null -eq $secret) {
        return $null
    }

    $ep = Parse-Endpoint -Endpoint $endpoint
    return @{
        server = $ep.Host
        server_port = $ep.Port
        password = $secret
        method = $cipher
    }
}

function Resolve-AccessRuntime {
    param(
        [string]$Key,
        [int]$Port
    )

    if ([string]::IsNullOrWhiteSpace($Key)) {
        throw "Access key is empty."
    }

    $trimmed = $Key.Trim()
    $payload = $null
    $source = ""

    if ($trimmed.StartsWith("ss://")) {
        $source = "inline-ss-url"
        return @{
            Mode = "server_url"
            ServerUrl = $trimmed
            ConfigJson = ""
            Source = $source
            Summary = "Resolved as direct ss:// URL."
        }
    }

    if ($trimmed.StartsWith("ssconf://")) {
        $source = "dynamic-ssconf"
        $url = "https://" + $trimmed.Substring("ssconf://".Length)
        $payload = (Get-UrlBody -Url $url).Trim()
    } elseif ($trimmed.StartsWith("https://") -or $trimmed.StartsWith("http://")) {
        $source = "dynamic-http"
        $payload = (Get-UrlBody -Url $trimmed).Trim()
    } else {
        throw "Unsupported key format. Expected ssconf://, ss://, https:// or http://"
    }

    if ($payload.StartsWith("ss://")) {
        return @{
            Mode = "server_url"
            ServerUrl = $payload
            ConfigJson = ""
            Source = $source
            Summary = "Dynamic key returned ss:// URL."
        }
    }

    $configObj = $null
    try {
        $obj = $payload | ConvertFrom-Json -ErrorAction Stop
        if ($obj -and $obj.PSObject.Properties.Name -contains "error" -and -not [string]::IsNullOrWhiteSpace([string]$obj.error)) {
            throw "Access provider returned error: $($obj.error)"
        }

        $hasDirect = ($obj.PSObject.Properties.Name -contains "server") -and
            ($obj.PSObject.Properties.Name -contains "server_port") -and
            ($obj.PSObject.Properties.Name -contains "password") -and
            ($obj.PSObject.Properties.Name -contains "method")

        if ($hasDirect) {
            $configObj = @{
                server = [string]$obj.server
                server_port = [int]$obj.server_port
                password = [string]$obj.password
                method = [string]$obj.method
            }
        } elseif ($obj.PSObject.Properties.Name -contains "transport" -and $obj.transport -and $obj.transport.tcp) {
            $tcp = $obj.transport.tcp
            if ($tcp.endpoint -and $tcp.cipher -and $tcp.secret) {
                $ep = Parse-Endpoint -Endpoint ([string]$tcp.endpoint)
                $configObj = @{
                    server = $ep.Host
                    server_port = [int]$ep.Port
                    password = [string]$tcp.secret
                    method = [string]$tcp.cipher
                }
            }
        }
    } catch {
        $configObj = $null
    }

    if ($null -eq $configObj) {
        $yamlObj = Parse-YamlLikePayload -Payload $payload
        if ($null -ne $yamlObj) {
            $configObj = $yamlObj
        }
    }

    if ($null -eq $configObj) {
        throw "Dynamic key payload is not recognized as ss://, JSON, or YAML config."
    }

    $runtimeConfigObj = @{
        local_address = "127.0.0.1"
        local_port = $Port
        server = $configObj.server
        server_port = [int]$configObj.server_port
        password = $configObj.password
        method = $configObj.method
    }
    $runtimeConfig = $runtimeConfigObj | ConvertTo-Json -Compress
    $summary = "server=$($runtimeConfigObj.server):$($runtimeConfigObj.server_port), method=$($runtimeConfigObj.method)"

    return @{
        Mode = "config"
        ServerUrl = ""
        ConfigJson = $runtimeConfig
        Source = $source
        Summary = $summary
    }
}

function Set-LocalCodexWorkspaceMode {
    $settingsPath = Join-Path $env:APPDATA "Code\User\settings.json"
    $backupDir = Join-Path $PSScriptRoot "backups"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    $pythonScript = @'
import json
import pathlib
import re
import shutil
import sys
import datetime as dt

settings_path = pathlib.Path(sys.argv[1]).expanduser()
backup_dir = pathlib.Path(sys.argv[2]).expanduser()

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
    cleaned = "".join(result)
    cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
    return cleaned

if settings_path.exists():
    raw = settings_path.read_text(encoding="utf-8")
    cleaned = strip_jsonc(raw).strip()
    data = json.loads(cleaned) if cleaned else {}
    if not isinstance(data, dict):
        data = {}
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = backup_dir / f"settings.json.{stamp}.bak"
    shutil.copy2(settings_path, backup)
    print(f"local_backup={backup}")
else:
    data = {}

remote_extension_kind = data.get("remote.extensionKind")
if not isinstance(remote_extension_kind, dict):
    remote_extension_kind = {}
    data["remote.extensionKind"] = remote_extension_kind

remote_extension_kind["openai.chatgpt"] = ["workspace"]

settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(f"local_settings_updated={settings_path}")
print("codex_runtime=workspace")
'@

    Write-Log -Level INFO -Message "Ensuring local Codex runtime is workspace..."
    try {
        $pythonScript | python - $settingsPath $backupDir
    } catch {
        Write-Log -Level WARN -Message "Could not update local Codex runtime automatically. You can set remote.extensionKind.openai.chatgpt to [\"workspace\"] manually."
    }
}

if ($SocksPort -lt 1 -or $SocksPort -gt 65535) {
    throw "SocksPort must be in range 1..65535"
}

if (($Action -eq "up") -and [string]::IsNullOrWhiteSpace($AccessKey)) {
    $AccessKey = Read-Host "Paste your ssconf:// or ss:// key"
}

$runtimeMode = ""
$serverUrlB64 = ""
$configB64 = ""

if (($Action -eq "up") -and -not [string]::IsNullOrWhiteSpace($AccessKey)) {
    Write-Log -Level INFO -Message "Resolving access key payload..."
    $runtime = Resolve-AccessRuntime -Key $AccessKey -Port $SocksPort
    Write-Log -Level OK -Message ("Key resolved via " + $runtime.Source + ". " + $runtime.Summary)
    $runtimeMode = [string]$runtime.Mode
    if ($runtimeMode -eq "server_url") {
        $serverUrlB64 = Encode-Base64Utf8 -Text ([string]$runtime.ServerUrl)
    } elseif ($runtimeMode -eq "config") {
        $configB64 = Encode-Base64Utf8 -Text ([string]$runtime.ConfigJson)
    } else {
        throw "Unexpected runtime mode: $runtimeMode"
    }
}

if (-not $SkipLocalCodexWorkspace -and $Action -eq "up") {
    Set-LocalCodexWorkspaceMode
}

$sshExe = Resolve-SshExe

$remoteScript = @'
set -euo pipefail

ACTION="${ACTION:-status}"
SOCKS_PORT="${SOCKS_PORT:-1080}"
SS_VERSION="${SS_VERSION:-v1.24.0}"
RUNTIME_MODE="${RUNTIME_MODE:-}"
SERVER_URL_B64="${SERVER_URL_B64:-}"
CONFIG_B64="${CONFIG_B64:-}"
TEST_URL="${TEST_URL:-https://api.openai.com/v1/models}"
TAIL_LINES="${TAIL_LINES:-80}"

BASE_DIR="$HOME/.codex-ssproxy"
BIN_DIR="$BASE_DIR/bin"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/log"
TMP_DIR="$BASE_DIR/tmp"
PID_FILE="$STATE_DIR/sslocal.pid"
MODE_FILE="$STATE_DIR/mode"
URL_FILE="$STATE_DIR/server_url.txt"
CFG_FILE="$STATE_DIR/config.json"
LOG_FILE="$LOG_DIR/sslocal.log"
SSLOCAL_BIN="$BIN_DIR/sslocal"
VSCODE_MACHINE_SETTINGS="$HOME/.vscode-server/data/Machine/settings.json"

mkdir -p "$BIN_DIR" "$STATE_DIR" "$LOG_DIR" "$TMP_DIR"
mkdir -p "$(dirname "$VSCODE_MACHINE_SETTINGS")"

log() {
  printf '[%s][%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$1" "$2"
}

detect_target() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) echo "x86_64-unknown-linux-gnu" ;;
    aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
    *) echo "unsupported:${arch}" ;;
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
    log ERROR "Unsupported architecture for auto-install: ${target#unsupported:}"
    return 2
  fi

  local archive url tmp
  archive="shadowsocks-${SS_VERSION}.${target}.tar.xz"
  url="https://github.com/shadowsocks/shadowsocks-rust/releases/download/${SS_VERSION}/${archive}"
  tmp="$(mktemp -d "$TMP_DIR/install.XXXXXX")"

  log INFO "Downloading $url"
  curl -fL --retry 3 --connect-timeout 15 "$url" -o "$tmp/$archive"
  tar -xf "$tmp/$archive" -C "$tmp"
  if [ ! -f "$tmp/sslocal" ]; then
    log ERROR "sslocal not found in extracted archive."
    return 3
  fi

  install -m 0755 "$tmp/sslocal" "$SSLOCAL_BIN"
  rm -rf "$tmp"
  log OK "Installed sslocal to $SSLOCAL_BIN"
  "$SSLOCAL_BIN" --version | head -n1 | sed 's/^/[sslocal-version] /'
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
  if ps -p "$pid" >/dev/null 2>&1; then
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
  if ps -p "$pid" >/dev/null 2>&1; then
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
    printf 'server_url\n' > "$MODE_FILE"
    log INFO "Stored runtime mode: server_url"
    return 0
  fi

  if [ "$RUNTIME_MODE" = "config" ]; then
    if [ -z "$CONFIG_B64" ]; then
      log ERROR "RUNTIME_MODE=config but CONFIG_B64 is empty."
      return 11
    fi
    printf '%s' "$CONFIG_B64" | base64 -d > "$CFG_FILE"
    printf 'config\n' > "$MODE_FILE"
    log INFO "Stored runtime mode: config"
    return 0
  fi

  log ERROR "Missing or unsupported RUNTIME_MODE. Expected server_url or config."
  return 12
}

start_sslocal() {
  install_sslocal
  write_runtime_files
  stop_sslocal >/dev/null 2>&1 || true

  local mode
  mode="$(cat "$MODE_FILE")"
  : > "$LOG_FILE"

  if [ "$mode" = "server_url" ]; then
    local server_url
    server_url="$(cat "$URL_FILE")"
    nohup "$SSLOCAL_BIN" -b "127.0.0.1:${SOCKS_PORT}" --server-url "$server_url" >>"$LOG_FILE" 2>&1 &
  else
    nohup "$SSLOCAL_BIN" -c "$CFG_FILE" >>"$LOG_FILE" 2>&1 &
  fi

  local pid
  pid="$!"
  echo "$pid" > "$PID_FILE"
  sleep 1
  if ps -p "$pid" >/dev/null 2>&1; then
    log OK "sslocal started (pid=$pid), socks=127.0.0.1:${SOCKS_PORT}"
  else
    log ERROR "sslocal failed to start. Last log lines:"
    tail -n 50 "$LOG_FILE" || true
    return 20
  fi
}

set_vscode_proxy() {
  local mode="$1"
  local proxy_url="$2"

  python3 - "$VSCODE_MACHINE_SETTINGS" "$mode" "$proxy_url" <<'PY'
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
    cleaned = "".join(result)
    return re.sub(r",\s*([}\]])", r"\1", cleaned)

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
path.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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
  python3 - "$VSCODE_MACHINE_SETTINGS" <<'PY'
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
    log INFO "Last ${TAIL_LINES} proxy log lines:"
    tail -n "$TAIL_LINES" "$LOG_FILE" || true
  fi
}

test_proxy() {
  local rc
  log INFO "Testing proxy with curl via socks5-hostname: $TEST_URL"
  set +e
  curl -sS -o /dev/null -w "http_code=%{http_code}\n" --connect-timeout 12 --socks5-hostname "127.0.0.1:${SOCKS_PORT}" "$TEST_URL"
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
    log INFO "Showing last ${TAIL_LINES} lines from $LOG_FILE"
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
    set_vscode_proxy enable "socks5://127.0.0.1:${SOCKS_PORT}"
    test_proxy
    status_sslocal
    ;;
  down)
    stop_sslocal
    set_vscode_proxy disable "socks5://127.0.0.1:${SOCKS_PORT}"
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
'@

$remoteScript = $remoteScript -replace "`r", ""
$remoteCommand = "tr -d '\r' | ACTION='$Action' SOCKS_PORT='$SocksPort' SS_VERSION='$ShadowsocksVersion' RUNTIME_MODE='$runtimeMode' SERVER_URL_B64='$serverUrlB64' CONFIG_B64='$configB64' TEST_URL='$TestUrl' TAIL_LINES='$LogTailLines' bash -s"

Write-Log -Level INFO -Message ("Running remote action '" + $Action + "' on " + $SshHost + " ...")
$remoteOutput = $remoteScript | & $sshExe $SshHost $remoteCommand 2>&1
$remoteExit = $LASTEXITCODE
if ($null -ne $remoteOutput) {
    $remoteOutput | ForEach-Object { Write-Host $_ }
}
if ($remoteExit -ne 0) {
    throw "Remote proxy orchestration failed with exit code $remoteExit"
}

if ($Action -eq "up") {
    Write-Log -Level OK -Message "Proxy mode is up. Restart VS Code and reconnect to the SSH host."
}

