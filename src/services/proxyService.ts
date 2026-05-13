import * as vscode from "vscode";
import { resolveAccessKey, type AccessKeyRuntime } from "./accessKeyResolver";
import {
  type ClusterProfileConfig,
  type ClusterProfileType,
} from "./clusterProfile";
import { runLocalScript } from "./localRunner";
import {
  type ActionName,
  buildSecretKey,
  deriveHostFromAuthority,
  deriveStatusPatch,
  normalizeProxyError,
  parseScriptEvent,
  type ProxyStatusSnapshot,
  redactLine
} from "./proxyCore";
import { SETUP_REMOTE_SCRIPT, REVERT_REMOTE_SCRIPT } from "./remoteScripts";
import { runRemoteScript } from "./sshRunner";

const OUTPUT_NAME = "Remote Proxy";
const STATUS_PREFIX = "remoteProxy.status.";
const LAST_HOST_KEY = "remoteProxy.lastSshHost";

interface RemoteProxyConfig {
  sshHost: string;
  socksPort: number;
  httpPort: number;
  shadowsocksVersion: string;
  testUrl: string;
  testExpectedHttpCodes: string;
  logTailLines: number;
  confirmBeforeMutations: boolean;
  clusterProfile: ClusterProfileType;
  dockerContainer: string;
  customCommandTemplate: string;
  wrapClaudeCode: boolean;
}

interface ScriptRunResult {
  exitCode: number;
  lines: string[];
}

export class ProxyService {
  private readonly output: vscode.OutputChannel;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly memoryStatus = new Map<string, ProxyStatusSnapshot>();

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel(OUTPUT_NAME);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
    this.statusBar.command = "remoteProxy.showQuickActions";
    this.statusBar.show();
  }

  public dispose(): void {
    this.output.dispose();
    this.statusBar.dispose();
  }

  public async initialize(): Promise<void> {
    await this.refreshUi();
  }

  public async configureAccessKey(): Promise<void> {
    const authority = this.getAuthority();
    const input = await vscode.window.showInputBox({
      title: "Configure Proxy Access Key",
      prompt: "Enter ssconf://, ss://, https:// or http:// access key",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "ssconf://...",
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Access key is required.";
        }
        if (/^(ssconf|ss|https?|http):\/\//i.test(trimmed)) {
          return undefined;
        }
        return "Access key must start with ssconf://, ss://, https://, or http://";
      }
    });
    if (!input) {
      return;
    }
    await this.context.secrets.store(buildSecretKey(authority), input.trim());
    await vscode.window.showInformationMessage(`Proxy access key saved for ${authority}.`);
    await this.updateStatus(authority, {
      lastAction: "configureAccessKey"
    });
    await this.refreshUi();
  }

  public async enable(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const host = isLocal ? "localhost" : await this.resolveHost(authority);
    const key = await this.context.secrets.get(buildSecretKey(authority));
    if (!key) {
      await vscode.window.showErrorMessage(
        "No access key configured for this host. Run 'Proxy: Configure Access Key' first."
      );
      return;
    }

    if (!(await this.confirmMutation("Enable", host, "install/start proxy and update VS Code proxy settings"))) {
      return;
    }

    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "enable", async () => {
      this.output.appendLine("[INFO] Resolving access key payload...");
      const runtime = await resolveAccessKey(key);
      this.output.appendLine(`[OK] Key resolved via ${runtime.source}. ${runtime.summary}`);
      await this.runSetupAction("up", host, cfg, runtime, key, isLocal);
      const claudeHint = cfg.wrapClaudeCode
        ? " If a Claude Code session is open, close and reopen it (or reload the window) so the wrapped 'claude' binary is used."
        : "";
      const applyHint = isLocal
        ? `Reload the window (Ctrl+Shift+P → Reload Window) to apply.${claudeHint}`
        : `Reload the window to apply http.proxy and terminal env. For extensions whose subprocesses must also be proxied, run 'Remote-SSH: Kill VS Code Server on Host' and reconnect so server-env-setup is sourced.${claudeHint}`;
      await vscode.window.showInformationMessage(`Proxy enabled. ${applyHint}`);
    });
  }

  public async disable(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const host = isLocal ? "localhost" : await this.resolveHost(authority);
    if (!(await this.confirmMutation("Disable", host, "stop proxy, clear proxy settings, and uninstall sslocal"))) {
      return;
    }
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "disable", async () => {
      await this.runRevertAction(host, cfg, isLocal);
      await vscode.window.showInformationMessage("Proxy disabled.");
    });
  }

  public async status(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const host = isLocal ? "localhost" : await this.resolveHost(authority);
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "status", async () => {
      await this.runSetupAction("status", host, cfg, undefined, undefined, isLocal);
      this.output.show(true);
    });
  }

  public async testConnectivity(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const host = isLocal ? "localhost" : await this.resolveHost(authority);
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "test", async () => {
      await this.runSetupAction("test", host, cfg, undefined, undefined, isLocal);
      await vscode.window.showInformationMessage("Connectivity test completed.");
    });
  }

  public async showLogs(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const host = isLocal ? "localhost" : await this.resolveHost(authority);
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "logs", async () => {
      await this.runSetupAction("logs", host, cfg, undefined, undefined, isLocal);
      this.output.show(true);
    });
  }

  public async reinstallSslocal(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const host = isLocal ? "localhost" : await this.resolveHost(authority);
    if (!(await this.confirmMutation("Reinstall sslocal", host, "reinstall shadowsocks client binary"))) {
      return;
    }
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "reinstall", async () => {
      await this.runSetupAction("install", host, cfg, undefined, undefined, isLocal);
      await vscode.window.showInformationMessage("sslocal reinstall completed.");
    });
  }

  public async selectProfile(): Promise<void> {
    const cfg = this.getConfig();
    const items: Array<{ label: string; description: string; value: ClusterProfileType }> = [
      {
        label: "Direct",
        description: cfg.clusterProfile === "direct" ? "(current)" : "",
        value: "direct",
      },
      {
        label: "Docker",
        description: cfg.clusterProfile === "docker" ? "(current)" : "",
        value: "docker",
      },
      {
        label: "Custom",
        description: cfg.clusterProfile === "custom" ? "(current)" : "",
        value: "custom",
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Select Cluster Execution Profile",
      placeHolder: "How should commands be executed on the remote host?",
    });
    if (!picked) {
      return;
    }

    const wsCfg = vscode.workspace.getConfiguration("remoteProxy");
    await wsCfg.update("clusterProfile", picked.value, vscode.ConfigurationTarget.Global);

    if (picked.value === "docker") {
      const container = await vscode.window.showInputBox({
        title: "Docker Container Name",
        prompt: "Enter the name or ID of the Docker container to execute commands in",
        value: cfg.dockerContainer || "",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Container name is required."),
      });
      if (container === undefined) {
        return;
      }
      await wsCfg.update("dockerContainer", container.trim(), vscode.ConfigurationTarget.Global);
    }

    if (picked.value === "custom") {
      const template = await vscode.window.showInputBox({
        title: "Custom Command Template",
        prompt: "Enter a command template. Use {{SCRIPT}} as placeholder for the bash invocation.",
        value: cfg.customCommandTemplate || "sudo {{SCRIPT}}",
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!v.trim()) {
            return "Template is required.";
          }
          if (!v.includes("{{SCRIPT}}")) {
            return "Template must contain {{SCRIPT}} placeholder.";
          }
          return undefined;
        },
      });
      if (template === undefined) {
        return;
      }
      await wsCfg.update("customCommandTemplate", template.trim(), vscode.ConfigurationTarget.Global);
    }

    await vscode.window.showInformationMessage(`Cluster profile set to '${picked.value}'.`);
    await this.refreshUi();
  }

  public async showQuickActions(): Promise<void> {
    const cfg = this.getConfig();
    const profileLabel = `Profile: ${cfg.clusterProfile}`;
    const quickPick = await vscode.window.showQuickPick(
      [
        { label: "Enable", command: "remoteProxy.enable" },
        { label: "Disable", command: "remoteProxy.disable" },
        { label: "Status", command: "remoteProxy.status" },
        { label: "Test Connectivity", command: "remoteProxy.testConnectivity" },
        { label: "Show Logs", command: "remoteProxy.showLogs" },
        { label: "Reinstall sslocal", command: "remoteProxy.reinstallSslocal" },
        { label: "Configure Access Key", command: "remoteProxy.configureAccessKey" },
        { label: `Select Cluster Profile (${profileLabel})`, command: "remoteProxy.selectProfile" }
      ],
      {
        title: "Remote Proxy Actions"
      }
    );
    if (!quickPick) {
      return;
    }
    await vscode.commands.executeCommand(quickPick.command);
  }

  public async refreshUi(): Promise<void> {
    const authority = this.getAuthority();
    const isLocal = authority === "local";
    const modeLabel = isLocal ? "Local" : "Remote";
    const snapshot = await this.readStatus(authority);
    if (snapshot.runningState === "on" && snapshot.proxyState !== "disabled") {
      this.statusBar.text = "$(shield) Proxy: On";
      this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (snapshot.lastErrorCode) {
      this.statusBar.text = "$(error) Proxy: Error";
      this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (snapshot.runningState === "off" || snapshot.proxyState === "disabled") {
      this.statusBar.text = "$(circle-slash) Proxy: Off";
      this.statusBar.backgroundColor = undefined;
    } else {
      this.statusBar.text = "$(question) Proxy: Unknown";
      this.statusBar.backgroundColor = undefined;
    }
    this.statusBar.tooltip = this.renderTooltip(authority, snapshot);
  }

  private renderTooltip(authority: string, snapshot: ProxyStatusSnapshot): string {
    const mode = authority === "local" ? "Local" : "Remote";
    const lines = [
      `Mode: ${mode}`,
      `Authority: ${authority}`,
      `Last action: ${snapshot.lastAction}`,
      `Running state: ${snapshot.runningState}`,
      `Proxy settings: ${snapshot.proxyState}`
    ];
    if (snapshot.lastSuccessAt) {
      lines.push(`Last success: ${snapshot.lastSuccessAt}`);
    }
    if (snapshot.lastFailureAt) {
      lines.push(`Last failure: ${snapshot.lastFailureAt}`);
    }
    if (snapshot.lastErrorCode) {
      lines.push(`Last error: ${snapshot.lastErrorCode}`);
    }
    return lines.join("\n");
  }

  private async executeWithStatus(authority: string, action: ActionName, operation: () => Promise<void>): Promise<void> {
    await this.updateStatus(authority, { lastAction: action });
    try {
      await operation();
      await this.updateStatus(authority, {
        lastSuccessAt: new Date().toISOString(),
        lastErrorCode: undefined,
        lastErrorMessage: undefined
      });
    } catch (error) {
      const normalized = normalizeProxyError(error);
      await this.updateStatus(authority, {
        lastFailureAt: new Date().toISOString(),
        lastErrorCode: normalized.code,
        lastErrorMessage: normalized.message
      });
      await vscode.window.showErrorMessage(`${normalized.code}: ${normalized.message}`);
    } finally {
      await this.refreshUi();
    }
  }

  private getConfig(): RemoteProxyConfig {
    const cfg = vscode.workspace.getConfiguration("remoteProxy");
    return {
      sshHost: `${cfg.get<string>("sshHost", "")}`.trim(),
      socksPort: cfg.get<number>("socksPort", 1080),
      httpPort: cfg.get<number>("httpPort", 1081),
      shadowsocksVersion: `${cfg.get<string>("shadowsocksVersion", "v1.24.0")}`.trim(),
      testUrl: `${cfg.get<string>("testUrl", "https://api.openai.com/v1/models")}`.trim(),
      testExpectedHttpCodes: `${cfg.get<string>("testExpectedHttpCodes", "200,204,301,302,307,308,401,403")}`.trim(),
      logTailLines: cfg.get<number>("logTailLines", 80),
      confirmBeforeMutations: cfg.get<boolean>("confirmBeforeMutations", false),
      clusterProfile: cfg.get<ClusterProfileType>("clusterProfile", "direct"),
      dockerContainer: `${cfg.get<string>("dockerContainer", "")}`.trim(),
      customCommandTemplate: `${cfg.get<string>("customCommandTemplate", "")}`.trim(),
      wrapClaudeCode: cfg.get<boolean>("wrapClaudeCode", true),
    };
  }

  private getAuthority(): string {
    const folderAuthority = vscode.workspace.workspaceFolders?.[0]?.uri.authority;
    if (folderAuthority?.startsWith("ssh-remote+")) {
      return folderAuthority;
    }
    if (vscode.env.remoteName === "ssh-remote") {
      return "ssh-remote";
    }
    return "local";
  }

  private async resolveHost(authority: string): Promise<string> {
    const cfg = this.getConfig();
    const direct = deriveHostFromAuthority(authority, cfg.sshHost);
    if (direct && direct !== "ssh-remote") {
      await this.context.globalState.update(LAST_HOST_KEY, direct);
      return direct;
    }

    try {
      const active = await vscode.commands.executeCommand<string | undefined>("remote-internal.getActiveSshRemote");
      const raw = `${active ?? ""}`.trim();
      if (raw) {
        const parsed = raw.startsWith("ssh-remote+") ? decodeURIComponent(raw.slice("ssh-remote+".length)) : raw;
        if (parsed && parsed !== "ssh-remote") {
          await this.context.globalState.update(LAST_HOST_KEY, parsed);
          return parsed;
        }
      }
    } catch {
      // command may not be available depending on remote extension state
    }

    const remembered = `${this.context.globalState.get<string>(LAST_HOST_KEY, "")}`.trim();
    if (remembered) {
      return remembered;
    }

    throw new Error(
      "Unable to determine Remote-SSH host automatically. Set 'remoteProxy.sshHost' in settings and retry."
    );
  }

  private async readStatus(authority: string): Promise<ProxyStatusSnapshot> {
    const inMemory = this.memoryStatus.get(authority);
    if (inMemory) {
      return inMemory;
    }
    const persisted = this.context.globalState.get<ProxyStatusSnapshot>(`${STATUS_PREFIX}${authority}`);
    if (persisted) {
      this.memoryStatus.set(authority, persisted);
      return persisted;
    }
    const initial: ProxyStatusSnapshot = {
      lastAction: "none",
      runningState: "unknown",
      proxyState: "unknown"
    };
    this.memoryStatus.set(authority, initial);
    return initial;
  }

  private async updateStatus(authority: string, patch: Partial<ProxyStatusSnapshot>): Promise<void> {
    const current = await this.readStatus(authority);
    const next: ProxyStatusSnapshot = {
      ...current,
      ...patch
    };
    this.memoryStatus.set(authority, next);
    await this.context.globalState.update(`${STATUS_PREFIX}${authority}`, next);
  }

  private async confirmMutation(title: string, host: string, effect: string): Promise<boolean> {
    if (!this.getConfig().confirmBeforeMutations) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `${title} proxy on '${host}'? This will ${effect}.`,
      { modal: true },
      "Run",
      "Cancel"
    );
    return choice === "Run";
  }

  // ---------------------------------------------------------------------------
  // Script execution — dispatches to local or SSH runner
  // ---------------------------------------------------------------------------

  private async runSetupAction(
    action: "up" | "down" | "status" | "test" | "logs" | "install",
    host: string,
    cfg: RemoteProxyConfig,
    runtime?: AccessKeyRuntime,
    accessKey?: string,
    isLocal?: boolean
  ): Promise<ScriptRunResult> {
    const envVars: Record<string, string> = {
      ACTION: action,
      SOCKS_PORT: `${cfg.socksPort}`,
      HTTP_PORT: `${cfg.httpPort}`,
      SS_VERSION: cfg.shadowsocksVersion,
      TEST_URL: cfg.testUrl,
      TEST_EXPECTED_HTTP_CODES: cfg.testExpectedHttpCodes,
      TAIL_LINES: `${cfg.logTailLines}`,
      WRAP_CLAUDE_CODE: cfg.wrapClaudeCode ? "1" : "0",
    };
    if (runtime) {
      envVars.SERVER_INFO_B64 = runtime.serverInfoB64;
    }
    const secrets = accessKey ? [accessKey] : [];
    return this.executeScript(host, SETUP_REMOTE_SCRIPT, envVars, secrets, isLocal);
  }

  private async runRevertAction(
    host: string,
    cfg: RemoteProxyConfig,
    isLocal?: boolean
  ): Promise<ScriptRunResult> {
    const envVars: Record<string, string> = {
      SOCKS_PORT: `${cfg.socksPort}`,
      HTTP_PORT: `${cfg.httpPort}`,
      TAIL_LINES: `${cfg.logTailLines}`,
      REMOVE_ALL_STATE: "0",
    };
    return this.executeScript(host, REVERT_REMOTE_SCRIPT, envVars, [], isLocal);
  }

  private async executeScript(
    host: string,
    script: string,
    envVars: Record<string, string>,
    extraSecrets: string[],
    isLocal?: boolean
  ): Promise<ScriptRunResult> {
    const cfg = this.getConfig();
    const profileConfig: ClusterProfileConfig = {
      profile: cfg.clusterProfile,
      dockerContainer: cfg.dockerContainer,
      customCommandTemplate: cfg.customCommandTemplate,
    };

    const allLines: string[] = [];
    const runtimeSecrets = [...extraSecrets];

    // Log the command with sensitive values redacted
    const safeEnv = Object.entries(envVars)
      .map(([k, v]) => {
        if (/key|secret|password|b64/iu.test(k) && v) {
          return `${k}=<redacted>`;
        }
        return `${k}=${v}`;
      })
      .join(" ");
    const profileTag = cfg.clusterProfile === "direct"
      ? ""
      : ` [profile=${cfg.clusterProfile}]`;
    const modeTag = isLocal ? "local" : `ssh ${host}`;
    this.output.appendLine(`$ ${modeTag}${profileTag} [${safeEnv}]`);

    const onLine = (raw: string): void => {
      const line = redactLine(raw, runtimeSecrets);
      allLines.push(line);
      const event = parseScriptEvent(line);
      const prefix = `[${event.kind.toUpperCase()}]`;
      this.output.appendLine(`${prefix} ${event.message}`);
    };

    const result = isLocal
      ? await runLocalScript(script, envVars, onLine, profileConfig)
      : await runRemoteScript(host, script, envVars, onLine, profileConfig);

    await this.deriveStatusFromOutput(allLines);

    if (result.exitCode !== 0) {
      const err = new Error(`Script exited with code ${result.exitCode}.`);
      (err as { output?: string[] }).output = allLines;
      throw err;
    }

    return {
      exitCode: result.exitCode,
      lines: allLines
    };
  }

  private async deriveStatusFromOutput(lines: string[]): Promise<void> {
    const authority = this.getAuthority();
    const patch = deriveStatusPatch(lines);
    if (Object.keys(patch).length > 0) {
      await this.updateStatus(authority, patch);
    }
  }
}
