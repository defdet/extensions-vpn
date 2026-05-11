import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

export interface SshRunResult {
  exitCode: number;
  lines: string[];
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

/**
 * Execute a bash script on a remote host over SSH.
 *
 * The script is piped via stdin with environment variables injected inline:
 *   ssh <host> "tr -d '\r' | KEY=val KEY2=val2 bash -s"
 *
 * This matches the execution model of the original PowerShell scripts.
 */
export function runRemoteScript(
  sshHost: string,
  script: string,
  envVars: Record<string, string>,
  onLine: (line: string) => void
): Promise<SshRunResult> {
  const sshBin = findSshExecutable();

  // Build environment prefix: KEY='val' KEY2='val2'
  const envParts = Object.entries(envVars)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");

  const remoteCommand = envParts
    ? `tr -d '\\r' | ${envParts} bash -s`
    : `tr -d '\\r' | bash -s`;

  const cleanScript = script.replace(/\r/g, "");

  const proc = cp.spawn(sshBin, [sshHost, remoteCommand], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
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
    proc.once("error", reject);
    proc.once("close", (code) => {
      resolve({ exitCode: code ?? 1, lines: allLines });
    });
  });
}
