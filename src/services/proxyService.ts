import * as cp from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import {
  type ActionName,
  buildRevertScriptArgs,
  buildSecretKey,
  buildSetupScriptArgs,
  deriveHostFromAuthority,
  deriveStatusPatch,
  normalizeProxyError,
  parseScriptEvent,
  type ProxyStatusSnapshot,
  redactLine
} from "./proxyCore";

const OUTPUT_NAME = "Remote Proxy";
const SCRIPT_SETUP = "setup_remote_ssconf_proxy.ps1";
const SCRIPT_REVERT = "revert_remote_ssconf_proxy.ps1";
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
      await this.runSetupScript("up", host, cfg, key);
      await vscode.window.showInformationMessage("Proxy enabled. Reconnect VS Code remote if needed.");
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
      await this.runRevertScript(host, cfg);
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
      await this.runSetupScript("status", host, cfg);
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
      await this.runSetupScript("test", host, cfg);
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
      await this.runSetupScript("logs", host, cfg);
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
      await this.runSetupScript("install", host, cfg);
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
      this.statusBar.text = "Proxy: On";
    } else if (snapshot.lastErrorCode) {
      this.statusBar.text = "Proxy: Error";
    } else if (snapshot.runningState === "off" || snapshot.proxyState === "disabled") {
      this.statusBar.text = "Proxy: Off";
    } else {
      this.statusBar.text = "Proxy: Unknown";
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

  private getPowerShellCommand(): { bin: string; args: string[] } {
    if (process.platform === "win32") {
      return { bin: "powershell.exe", args: ["-ExecutionPolicy", "Bypass"] };
    }
    return { bin: "pwsh", args: ["-ExecutionPolicy", "Bypass"] };
  }

  private extensionScriptPath(scriptName: string): string {
    return path.join(this.context.extensionPath, "resources", "scripts", scriptName);
  }

  private async runSetupScript(
    action: "up" | "down" | "status" | "test" | "logs" | "install",
    sshHost: string,
    cfg: RemoteProxyConfig,
    accessKey?: string
  ): Promise<ScriptRunResult> {
    const scriptPath = this.extensionScriptPath(SCRIPT_SETUP);
    const args = buildSetupScriptArgs(scriptPath, action, sshHost, cfg, accessKey);
    return this.runScript(args, accessKey ? [accessKey] : []);
  }

  private async runRevertScript(sshHost: string, cfg: RemoteProxyConfig): Promise<ScriptRunResult> {
    const scriptPath = this.extensionScriptPath(SCRIPT_REVERT);
    const args = buildRevertScriptArgs(scriptPath, sshHost, cfg);
    return this.runScript(args, []);
  }

  private async runScript(args: string[], extraSecrets: string[]): Promise<ScriptRunResult> {
    const cmd = this.getPowerShellCommand();
    const fullArgs = [...cmd.args, ...args];
    const allLines: string[] = [];
    const runtimeSecrets = [...extraSecrets];
    const safeArgs = this.sanitizeArgsForLog(fullArgs, runtimeSecrets);
    this.output.appendLine(`$ ${cmd.bin} ${safeArgs.map((part) => this.quoteArg(part)).join(" ")}`);
    const proc = cp.spawn(cmd.bin, fullArgs, {
      cwd: this.context.extensionPath,
      shell: false
    });
    const onLine = (raw: string): void => {
      const line = redactLine(raw, runtimeSecrets);
      allLines.push(line);
      const event = parseScriptEvent(line);
      const prefix = `[${event.kind.toUpperCase()}]`;
      this.output.appendLine(`${prefix} ${event.message}`);
    };

    const outRl = readline.createInterface({ input: proc.stdout });
    outRl.on("line", onLine);
    const errRl = readline.createInterface({ input: proc.stderr });
    errRl.on("line", onLine);

    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code) => resolve(code ?? 1));
    });

    await this.deriveStatusFromOutput(allLines);

    if (exitCode !== 0) {
      const err = new Error(`Script exited with code ${exitCode}.`);
      (err as { output?: string[] }).output = allLines;
      throw err;
    }

    return {
      exitCode,
      lines: allLines
    };
  }

  private sanitizeArgsForLog(args: string[], secrets: string[]): string[] {
    const out = [...args];
    for (let i = 0; i < out.length; i += 1) {
      if (/^-AccessKey$/iu.test(out[i]) && i + 1 < out.length) {
        out[i + 1] = "<redacted>";
      }
    }
    return out.map((arg) => redactLine(arg, secrets));
  }

  private quoteArg(arg: string): string {
    if (/[\s"]/u.test(arg)) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
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
