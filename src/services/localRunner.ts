import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  buildLocalCommand,
  type ClusterProfileConfig,
} from "./clusterProfile";

export interface LocalRunResult {
  exitCode: number;
  lines: string[];
}

/**
 * Find a bash executable for local script execution.
 *
 * - Linux / macOS: use `/bin/bash` or `bash` from PATH.
 * - Windows: locate Git Bash (`bash.exe` shipped with Git for Windows).
 *   Throws a user-friendly error if Git Bash is not installed.
 */
export function findLocalBash(): string {
  if (process.platform !== "win32") {
    // Linux / macOS — bash is virtually always available
    if (fs.existsSync("/bin/bash")) {
      return "/bin/bash";
    }
    return "bash";
  }

  // Windows — look for Git Bash
  const candidates: string[] = [];

  // 1. Standard install locations
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  for (const base of [programFiles, programFilesX86]) {
    candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    candidates.push(path.join(base, "Git", "usr", "bin", "bash.exe"));
  }

  // 2. User-scoped install (e.g. scoop, chocolatey, portable)
  const localAppData = process.env.LOCALAPPDATA || "";
  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Git Bash is required to run the proxy locally on Windows. " +
      "Install Git for Windows (https://git-scm.com/download/win) and retry."
  );
}

const DEFAULT_PROFILE: ClusterProfileConfig = {
  profile: "direct",
  dockerContainer: "",
  customCommandTemplate: "",
};

/**
 * Execute a bash script locally (without SSH).
 *
 * The script is piped via stdin, identical to the remote path but without
 * the SSH wrapper. Cluster profiles (docker, custom) are applied the same way.
 */
export function runLocalScript(
  script: string,
  envVars: Record<string, string>,
  onLine: (line: string) => void,
  profileConfig?: ClusterProfileConfig
): Promise<LocalRunResult> {
  const bashBin = findLocalBash();
  const profile = profileConfig ?? DEFAULT_PROFILE;

  // Build environment prefix: KEY='val' KEY2='val2'
  const envPrefix = Object.entries(envVars)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");

  const localCommand = buildLocalCommand(envPrefix, profile);

  const cleanScript = script.replace(/\r/g, "");

  // On Windows with Git Bash, we need to run bash -c "<command>"
  // and pipe the script via stdin.
  // On Linux/macOS, same approach works.
  const proc = cp.spawn(bashBin, ["-c", localCommand], {
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

  return new Promise<LocalRunResult>((resolve, reject) => {
    proc.once("error", (err) => {
      // Enhance spawn errors with a helpful message
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `Bash executable not found at '${bashBin}'. ` +
              "Ensure Git for Windows is installed if running on Windows."
          )
        );
        return;
      }
      reject(err);
    });
    proc.once("close", (code) => {
      resolve({ exitCode: code ?? 1, lines: allLines });
    });
  });
}
