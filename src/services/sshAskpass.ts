// SSH_ASKPASS helper plumbing.
//
// OpenSSH calls the program named by $SSH_ASKPASS whenever it needs to prompt
// for a password or key passphrase. With SSH_ASKPASS_REQUIRE=force (OpenSSH
// 8.4+) it does so even when a TTY exists. The helper just has to print the
// secret to stdout.
//
// We keep the password out of the on-disk helper itself — the helper file is
// a constant 1-line wrapper that echoes whatever value SSH_ASKPASS_PWD is set
// to in its inherited environment. The password lives only in the env of two
// short-lived processes (ssh and the askpass helper) plus VS Code's
// SecretStorage. Helper file is in a private 0700 temp dir, deleted in the
// caller's `finally`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AskpassHandle {
  /** Absolute path to the helper script. */
  helperPath: string;
  /** Env overrides to merge into the spawned ssh process. */
  envOverlay: Record<string, string>;
  /** Best-effort cleanup. Safe to call multiple times. */
  cleanup: () => void;
}

const POSIX_HELPER = `#!/bin/sh
printf '%s\\n' "$SSH_ASKPASS_PWD"
`;

const WIN_HELPER = "@echo off\r\necho %SSH_ASKPASS_PWD%\r\n";

export function makeAskpassHelper(password: string): AskpassHandle {
  // mkdtempSync on POSIX creates the dir with mode 0700; on Windows the
  // %TEMP% ACL is per-user by default.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-askpass-"));
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort: temp dir cleanup is non-critical
    }
  };

  if (process.platform === "win32") {
    const helperPath = path.join(dir, "askpass.cmd");
    fs.writeFileSync(helperPath, WIN_HELPER);
    return {
      helperPath,
      envOverlay: {
        SSH_ASKPASS: helperPath,
        SSH_ASKPASS_REQUIRE: "force",
        // Some OpenSSH builds still gate askpass on DISPLAY being non-empty
        // even though X11 forwarding is irrelevant on Windows.
        DISPLAY: "1",
        SSH_ASKPASS_PWD: password,
      },
      cleanup,
    };
  }

  const helperPath = path.join(dir, "askpass.sh");
  fs.writeFileSync(helperPath, POSIX_HELPER, { mode: 0o700 });
  return {
    helperPath,
    envOverlay: {
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":0",
      SSH_ASKPASS_PWD: password,
    },
    cleanup,
  };
}

/**
 * Heuristic match for "this SSH attempt failed because of authentication".
 * SSH exits with 255 on connection/auth errors and prints recognizable text
 * to stderr. We look at the combined stdout+stderr lines we captured.
 */
export function looksLikeSshAuthFailure(
  exitCode: number,
  lines: readonly string[]
): boolean {
  if (exitCode !== 255 && exitCode !== 1) {
    return false;
  }
  for (const raw of lines) {
    const line = raw.toLowerCase();
    if (
      line.includes("permission denied") ||
      line.includes("authentication failed") ||
      line.includes("password:") ||
      line.includes("passphrase for key") ||
      line.includes("too many authentication failures")
    ) {
      return true;
    }
  }
  return false;
}
