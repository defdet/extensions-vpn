import * as path from "node:path";
import * as fs from "node:fs";
import { runTests } from "@vscode/test-electron";

function ensureNoSpaceLink(targetPath: string): string {
  if (process.platform !== "win32") {
    return targetPath;
  }
  const linkPath = "C:\\tmp\\crb-ext";
  try {
    if (!fs.existsSync(linkPath)) {
      fs.symlinkSync(targetPath, linkPath, "junction");
    }
  } catch {
    return targetPath;
  }
  return linkPath;
}

async function main(): Promise<void> {
  try {
    const workspaceRoot = path.resolve(__dirname, "../../..");
    const normalizedRoot = ensureNoSpaceLink(workspaceRoot);
    const extensionDevelopmentPath = normalizedRoot;
    const extensionTestsPath = path.resolve(normalizedRoot, "out", "test", "integration", "suite", "index");
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [normalizedRoot, "--disable-extensions"]
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to run integration tests", error);
    process.exit(1);
  }
}

void main();
