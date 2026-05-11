import * as vscode from "vscode";
import { ProxyService } from "./services/proxyService";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const service = new ProxyService(context);
  context.subscriptions.push({ dispose: () => service.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("remoteProxy.configureAccessKey", async () => {
      await service.configureAccessKey();
    }),
    vscode.commands.registerCommand("remoteProxy.enable", async () => {
      await service.enable();
    }),
    vscode.commands.registerCommand("remoteProxy.disable", async () => {
      await service.disable();
    }),
    vscode.commands.registerCommand("remoteProxy.status", async () => {
      await service.status();
    }),
    vscode.commands.registerCommand("remoteProxy.testConnectivity", async () => {
      await service.testConnectivity();
    }),
    vscode.commands.registerCommand("remoteProxy.showLogs", async () => {
      await service.showLogs();
    }),
    vscode.commands.registerCommand("remoteProxy.reinstallSslocal", async () => {
      await service.reinstallSslocal();
    }),
    vscode.commands.registerCommand("remoteProxy.showQuickActions", async () => {
      await service.showQuickActions();
    }),
    vscode.commands.registerCommand("remoteProxy.selectProfile", async () => {
      await service.selectProfile();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("remoteProxy")) {
        await service.refreshUi();
      }
    })
  );

  await service.initialize();
}

export function deactivate(): void {
  // no-op
}

