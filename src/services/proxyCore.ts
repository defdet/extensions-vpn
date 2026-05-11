const SECRET_PREFIX = "remoteProxy.accessKey.";

export type ErrorCode =
  | "RemoteExecError"
  | "MissingDependencyError"
  | "AuthKeyError"
  | "ProxyStartError"
  | "SettingsMutationError";

export type RunningState = "on" | "off" | "unknown";
export type ProxySettingsState = "enabled" | "disabled" | "unknown";
export type ActionName =
  | "configureAccessKey"
  | "enable"
  | "disable"
  | "status"
  | "test"
  | "logs"
  | "reinstall";

export interface ProxyStatusSnapshot {
  lastAction: ActionName | "none";
  lastSuccessAt?: string;
  lastFailureAt?: string;
  runningState: RunningState;
  proxyState: ProxySettingsState;
  lastErrorCode?: ErrorCode;
  lastErrorMessage?: string;
}

export interface ScriptEvent {
  kind: "info" | "warn" | "error" | "ok";
  message: string;
}

export interface SetupArgsConfig {
  socksPort: number;
  shadowsocksVersion: string;
  testUrl: string;
  logTailLines: number;
}

export interface RevertArgsConfig {
  socksPort: number;
  logTailLines: number;
}

export function buildSecretKey(authority: string): string {
  return `${SECRET_PREFIX}${authority}`;
}

export function deriveHostFromAuthority(authority: string, configuredHost: string): string {
  if (configuredHost.trim()) {
    return configuredHost.trim();
  }
  if (authority.startsWith("ssh-remote+")) {
    return decodeURIComponent(authority.slice("ssh-remote+".length));
  }
  return authority;
}

export function parseScriptEvent(line: string): ScriptEvent {
  const normalized = line.trim();
  const match = normalized.match(/^\[[^\]]+\]\[(INFO|WARN|ERROR|OK)\]\s*(.*)$/u);
  if (!match) {
    return { kind: "info", message: normalized };
  }
  const level = match[1];
  const message = match[2];
  if (level === "WARN") {
    return { kind: "warn", message };
  }
  if (level === "ERROR") {
    return { kind: "error", message };
  }
  if (level === "OK") {
    return { kind: "ok", message };
  }
  return { kind: "info", message };
}

export function redactLine(line: string, secrets: string[]): string {
  let result = line;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length > 3) {
      result = result.split(trimmed).join("<redacted>");
    }
  }
  result = result.replace(/(password|secret|access[_ -]?key)\s*[:=]\s*([^\s,]+)/giu, "$1=<redacted>");
  result = result.replace(/\bss:\/\/[^\s]+/giu, "ss://<redacted>");
  return result;
}

export function deriveStatusPatch(lines: string[]): Partial<ProxyStatusSnapshot> {
  let runningState: RunningState | undefined;
  let proxyState: ProxySettingsState | undefined;
  for (const line of lines) {
    if (/sslocal is running/iu.test(line) || /started \(pid=/iu.test(line)) {
      runningState = "on";
    } else if (/sslocal is not running/iu.test(line) || /Stopped sslocal/iu.test(line)) {
      runningState = "off";
    }

    if (line.includes("[proxy-state]") || line.includes("[proxy-after]")) {
      if (/proxySupport['"]?\s*:\s*['"]on['"]/iu.test(line)) {
        proxyState = "enabled";
      } else if (/proxySupport['"]?\s*:\s*['"]off['"]/iu.test(line)) {
        proxyState = "disabled";
      }
    }
    if (line.includes("[proxy-mode] disable")) {
      proxyState = "disabled";
    }
    if (line.includes("[proxy-mode] enable")) {
      proxyState = "enabled";
    }
  }

  const patch: Partial<ProxyStatusSnapshot> = {};
  if (runningState) {
    patch.runningState = runningState;
  }
  if (proxyState) {
    patch.proxyState = proxyState;
  }
  return patch;
}

export function buildSetupScriptArgs(
  scriptPath: string,
  action: "up" | "down" | "status" | "test" | "logs" | "install",
  sshHost: string,
  cfg: SetupArgsConfig,
  accessKey?: string
): string[] {
  const args = [
    "-File",
    scriptPath,
    "-SshHost",
    sshHost,
    "-Action",
    action,
    "-SocksPort",
    `${cfg.socksPort}`,
    "-ShadowsocksVersion",
    cfg.shadowsocksVersion,
    "-TestUrl",
    cfg.testUrl,
    "-LogTailLines",
    `${cfg.logTailLines}`,
    "-SkipLocalCodexWorkspace"
  ];
  if (accessKey) {
    args.push("-AccessKey", accessKey);
  }
  return args;
}

export function buildRevertScriptArgs(scriptPath: string, sshHost: string, cfg: RevertArgsConfig): string[] {
  return [
    "-File",
    scriptPath,
    "-SshHost",
    sshHost,
    "-SocksPort",
    `${cfg.socksPort}`,
    "-LogTailLines",
    `${cfg.logTailLines}`
  ];
}

export function normalizeProxyError(error: unknown): { code: ErrorCode; message: string } {
  const baseMessage = error instanceof Error ? error.message : `${error ?? "Unknown error"}`;
  let combined = baseMessage;
  const maybeOutput = (error as { output?: string[] } | undefined)?.output;
  if (maybeOutput && maybeOutput.length > 0) {
    combined = `${baseMessage}\n${maybeOutput.slice(-10).join("\n")}`;
  }
  const lower = combined.toLowerCase();

  if (
    lower.includes("failed to fetch url") ||
    lower.includes("unsupported key format") ||
    lower.includes("access key is empty") ||
    lower.includes("provider returned error")
  ) {
    return {
      code: "AuthKeyError",
      message: "Access key validation failed. Reconfigure key and retry."
    };
  }
  if (lower.includes("python3") || lower.includes("curl") || lower.includes("unsupported architecture")) {
    return {
      code: "MissingDependencyError",
      message: "Remote host is missing required dependencies (python3/curl/compatible architecture)."
    };
  }
  if (lower.includes("failed to start") || lower.includes("proxy test curl failed")) {
    return {
      code: "ProxyStartError",
      message: "Proxy could not start or pass health check. Check output logs for details."
    };
  }
  if (lower.includes("proxy") && lower.includes("settings")) {
    return {
      code: "SettingsMutationError",
      message: "Remote VS Code proxy settings could not be updated."
    };
  }
  if (lower.includes("unable to determine remote-ssh host") || lower.includes("could not resolve hostname ssh-remote")) {
    return {
      code: "RemoteExecError",
      message: "SSH host resolution failed. Set 'remoteProxy.sshHost' and retry."
    };
  }
  return {
    code: "RemoteExecError",
    message: "Remote script execution failed. Check 'Remote Proxy' output for details."
  };
}
