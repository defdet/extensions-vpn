import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Extension Smoke", () => {
  test("commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      "remoteProxy.configureAccessKey",
      "remoteProxy.enable",
      "remoteProxy.disable",
      "remoteProxy.status",
      "remoteProxy.testConnectivity",
      "remoteProxy.showLogs",
      "remoteProxy.reinstallSslocal",
      "remoteProxy.showQuickActions"
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `Expected command: ${cmd}`);
    }
  });
});

