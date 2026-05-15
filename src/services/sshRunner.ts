import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  buildRemoteCommand,
  type ClusterProfileConfig,
} from "./clusterProfile";
import { makeAskpassHelper } from "./sshAskpass";

export interface SshRunResult {
  exitCode: number;
  lines: string[];
}

export interface SshAuth {
  kind: "askpass";
  password: string;
}

/**
 * Build SSH CLI args for non-interactive remote script execution.
 *
 * We explicitly clear configured forwards so actions triggered inside an
 * existing Remote-SSH session do not fail by trying to bind duplicate local
 * ports from ~/.ssh/config.
 */
export function buildSshArgs(sshHost: string, remoteCommand: string): string[] {
  return [
    "-o",
    "ClearAllForwardings=yes",
    sshHost,
    remoteCommand,
  ];
}

/**
 * Find the SSH executable on the local machine.
 * Windows: prefer the built-in OpenSSH, then fall back to PATH.
 * Linux/macOS: just use ssh from PATH.
 */
function findSshExecutable(): string {
  if (process.platform === "win32") {
    const preferred = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "OpenSSH",
      "ssh.exe"
    );
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  }
  return "ssh";
}

const DEFAULT_PROFILE: ClusterProfileConfig = {
  profile: "direct",
  dockerContainer: "",
  customCommandTemplate: "",
};

/**
 * Execute a bash script on a remote host over SSH.
 *
 * The script is piped via stdin. How the script is executed on the remote
 * side depends on the cluster profile:
 *   direct  — `tr -d '\r' | KEY=val bash -s`
 *   docker  — `tr -d '\r' | docker exec -i <container> env KEY=val bash -s`
 *   custom  — user-supplied template with `{{SCRIPT}}` placeholder
 */
export function runRemoteScript(
  sshHost: string,
  script: string,
  envVars: Record<string, string>,
  onLine: (line: string) => void,
  profileConfig?: ClusterProfileConfig,
  auth?: SshAuth
): Promise<SshRunResult> {
  const sshBin = findSshExecutable();
  const profile = profileConfig ?? DEFAULT_PROFILE;

  // Build environment prefix: KEY='val' KEY2='val2'
  const envPrefix = Object.entries(envVars)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");

  const remoteCommand = buildRemoteCommand(envPrefix, profile);

  const cleanScript = script.replace(/\r/g, "");

  // If password auth is requested, set up an SSH_ASKPASS helper. The helper
  // file is deleted in finally regardless of success/failure.
  const askpass =
    auth && auth.kind === "askpass" ? makeAskpassHelper(auth.password) : null;
  const childEnv: NodeJS.ProcessEnv = askpass
    ? { ...process.env, ...askpass.envOverlay }
    : process.env;

  const proc = cp.spawn(sshBin, buildSshArgs(sshHost, remoteCommand), {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    // Detach from any controlling TTY so SSH cannot open /dev/tty to prompt
    // directly, forcing it down the SSH_ASKPASS path on older OpenSSH builds
    // that don't honor SSH_ASKPASS_REQUIRE=force. Harmless when no TTY exists.
    detached: askpass != null && process.platform !== "win32",
  });

  // Pipe script to stdin
  proc.stdin.write(cleanScript);
  proc.stdin.end();

  const allLines: string[] = [];

  const handleLine = (raw: string): void => {
    allLines.push(raw);
    onLine(raw);
  };

  const outRl = readline.createInterface({ input: proc.stdout });
  outRl.on("line", handleLine);
  const errRl = readline.createInterface({ input: proc.stderr });
  errRl.on("line", handleLine);

  return new Promise<SshRunResult>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      try {
        askpass?.cleanup();
      } finally {
        fn();
      }
    };
    proc.once("error", (err) => finish(() => reject(err)));
    proc.once("close", (code) =>
      finish(() => resolve({ exitCode: code ?? 1, lines: allLines }))
    );
  });
}
