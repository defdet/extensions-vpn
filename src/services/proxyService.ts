import * as vscode from "vscode";
import { resolveAccessKey, type AccessKeyRuntime } from "./accessKeyResolver";
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
  shadowsocksVersion: string;
  testUrl: string;
  logTailLines: number;
  confirmBeforeMutations: boolean;
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
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
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
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
    const host = await this.resolveHost(authority);
    const key = await this.context.secrets.get(buildSecretKey(authority));
    if (!key) {
      await vscode.window.showErrorMessage(
        "No access key configured for this host. Run 'Proxy: Configure Access Key' first."
      );
      return;
    }

    if (!(await this.confirmMutation("Enable", host, "install/start proxy and update remote VS Code proxy settings"))) {
      return;
    }

    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "enable", async () => {
      this.output.appendLine("[INFO] Resolving access key payload...");
      const runtime = await resolveAccessKey(key, cfg.socksPort);
      this.output.appendLine(`[OK] Key resolved via ${runtime.source}. ${runtime.summary}`);
      await this.runSetupAction("up", host, cfg, runtime, key);
      await vscode.window.showInformationMessage("Proxy enabled. Reload the window (Ctrl+Shift+P → Reload Window) to apply.");
    });
  }

  public async disable(): Promise<void> {
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
    const host = await this.resolveHost(authority);
    if (!(await this.confirmMutation("Disable", host, "stop proxy, clear remote proxy settings, and uninstall sslocal"))) {
      return;
    }
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "disable", async () => {
      await this.runRevertAction(host, cfg);
      await vscode.window.showInformationMessage("Proxy disabled.");
    });
  }

  public async status(): Promise<void> {
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
    const host = await this.resolveHost(authority);
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "status", async () => {
      await this.runSetupAction("status", host, cfg);
      this.output.show(true);
    });
  }

  public async testConnectivity(): Promise<void> {
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
    const host = await this.resolveHost(authority);
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "test", async () => {
      await this.runSetupAction("test", host, cfg);
      await vscode.window.showInformationMessage("Connectivity test completed.");
    });
  }

  public async showLogs(): Promise<void> {
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
    const host = await this.resolveHost(authority);
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "logs", async () => {
      await this.runSetupAction("logs", host, cfg);
      this.output.show(true);
    });
  }

  public async reinstallSslocal(): Promise<void> {
    const authority = this.getRemoteAuthority();
    if (!authority) {
      await this.warnUnsupported();
      return;
    }
    const host = await this.resolveHost(authority);
    if (!(await this.confirmMutation("Reinstall sslocal", host, "reinstall shadowsocks client binary on remote host"))) {
      return;
    }
    const cfg = this.getConfig();
    await this.executeWithStatus(authority, "reinstall", async () => {
      await this.runSetupAction("install", host, cfg);
      await vscode.window.showInformationMessage("sslocal reinstall completed.");
    });
  }

  public async showQuickActions(): Promise<void> {
    const quickPick = await vscode.window.showQuickPick(
      [
        { label: "Enable", command: "remoteProxy.enable" },
        { label: "Disable", command: "remoteProxy.disable" },
        { label: "Status", command: "remoteProxy.status" },
        { label: "Test Connectivity", command: "remoteProxy.testConnectivity" },
        { label: "Show Logs", command: "remoteProxy.showLogs" },
        { label: "Reinstall sslocal", command: "remoteProxy.reinstallSslocal" },
        { label: "Configure Access Key", command: "remoteProxy.configureAccessKey" }
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
    const authority = this.getRemoteAuthority();
    if (!authority) {
      this.statusBar.text = "Proxy: Unsupported";
      this.statusBar.tooltip = "Remote Proxy works only in Remote-SSH sessions.";
      return;
    }
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
    const lines = [
      `Remote authority: ${authority}`,
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
      shadowsocksVersion: `${cfg.get<string>("shadowsocksVersion", "v1.24.0")}`.trim(),
      testUrl: `${cfg.get<string>("testUrl", "https://api.openai.com/v1/models")}`.trim(),
      logTailLines: cfg.get<number>("logTailLines", 80),
      confirmBeforeMutations: cfg.get<boolean>("confirmBeforeMutations", true)
    };
  }

  private getRemoteAuthority(): string | undefined {
    const folderAuthority = vscode.workspace.workspaceFolders?.[0]?.uri.authority;
    if (folderAuthority?.startsWith("ssh-remote+")) {
      return folderAuthority;
    }
    if (vscode.env.remoteName === "ssh-remote") {
      return "ssh-remote";
    }
    return undefined;
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
  // Remote execution — replaces PowerShell invocation with direct SSH
  // ---------------------------------------------------------------------------

  private async runSetupAction(
    action: "up" | "down" | "status" | "test" | "logs" | "install",
    sshHost: string,
    cfg: RemoteProxyConfig,
    runtime?: AccessKeyRuntime,
    accessKey?: string
  ): Promise<ScriptRunResult> {
    const envVars: Record<string, string> = {
      ACTION: action,
      SOCKS_PORT: `${cfg.socksPort}`,
      SS_VERSION: cfg.shadowsocksVersion,
      TEST_URL: cfg.testUrl,
      TAIL_LINES: `${cfg.logTailLines}`,
    };
    if (runtime) {
      envVars.RUNTIME_MODE = runtime.mode;
      envVars.SERVER_URL_B64 = runtime.serverUrlB64;
      envVars.CONFIG_B64 = runtime.configB64;
    }
    const secrets = accessKey ? [accessKey] : [];
    return this.executeRemote(sshHost, SETUP_REMOTE_SCRIPT, envVars, secrets);
  }

  private async runRevertAction(
    sshHost: string,
    cfg: RemoteProxyConfig
  ): Promise<ScriptRunResult> {
    const envVars: Record<string, string> = {
      SOCKS_PORT: `${cfg.socksPort}`,
      TAIL_LINES: `${cfg.logTailLines}`,
      REMOVE_ALL_STATE: "0",
    };
    return this.executeRemote(sshHost, REVERT_REMOTE_SCRIPT, envVars, []);
  }

  private async executeRemote(
    sshHost: string,
    script: string,
    envVars: Record<string, string>,
    extraSecrets: string[]
  ): Promise<ScriptRunResult> {
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
    this.output.appendLine(`$ ssh ${sshHost} [${safeEnv}]`);

    const onLine = (raw: string): void => {
      const line = redactLine(raw, runtimeSecrets);
      allLines.push(line);
      const event = parseScriptEvent(line);
      const prefix = `[${event.kind.toUpperCase()}]`;
      this.output.appendLine(`${prefix} ${event.message}`);
    };

    const result = await runRemoteScript(sshHost, script, envVars, onLine);

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
    const authority = this.getRemoteAuthority();
    if (!authority) {
      return;
    }
    const patch = deriveStatusPatch(lines);
    if (Object.keys(patch).length > 0) {
      await this.updateStatus(authority, patch);
    }
  }

  private async warnUnsupported(): Promise<void> {
    await vscode.window.showWarningMessage(
      "Remote Proxy v1 supports only active Remote-SSH sessions (vscode.env.remoteName === 'ssh-remote')."
    );
  }
}
