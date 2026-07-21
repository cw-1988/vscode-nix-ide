import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";
import * as client from "./client";
import { config } from "./configuration";
import { formattingProviders } from "./formatter";
import { startLinting } from "./linter";

let fallbackServices: vscode.Disposable | undefined;
let transition: Promise<void> = Promise.resolve();
let deactivating = false;

function stopFallbackServices(): void {
  fallbackServices?.dispose();
  fallbackServices = undefined;
}

async function startFallbackServices(): Promise<void> {
  const linting = await startLinting();
  try {
    fallbackServices = vscode.Disposable.from(
      linting,
      vscode.languages.registerDocumentFormattingEditProvider(
        "nix",
        formattingProviders,
      ),
      vscode.languages.registerDocumentRangeFormattingEditProvider(
        "nix",
        formattingProviders,
      ),
    );
  } catch (error) {
    linting.dispose();
    throw error;
  }
}

async function reconcileServices(): Promise<void> {
  await client.deactivate();
  stopFallbackServices();

  if (!config.LSPEnabled) {
    await startFallbackServices();
    return;
  }

  try {
    await client.activate();
  } catch (error) {
    console.error(error);
    await startFallbackServices();
  }
}

function scheduleReconcile(): Promise<void> {
  if (deactivating) {
    return Promise.resolve();
  }
  const next = transition.then(reconcileServices, reconcileServices);
  transition = next.catch(() => undefined);
  return next;
}

async function restartServices(): Promise<void> {
  const restartingMessage = vscode.window.setStatusBarMessage(
    "$(loading~spin) Restarting Nix language services",
  );
  try {
    await scheduleReconcile();
  } finally {
    restartingMessage.dispose();
  }
}

async function onConfigChange(event: vscode.ConfigurationChangeEvent) {
  if (!config.requiresServerRestart(event)) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "Configuration change requires (re)starting the language server",
    "Restart",
  );
  if (choice === "Restart") {
    await restartServices();
  }
}

/**
 * Activate this extension.
 *
 * If LSP is enabled
 *    then support IDE features with an available LSP
 * Else
 *    Format with nixpkgs-format
 *    validate with nix-instantiate
 *
 * @param context The context for this extension
 * @return A promise for the initialization
 */
export async function activate(context: ExtensionContext): Promise<void> {
  context.subscriptions.push(
    client.getOutputChannel(),
    vscode.workspace.onDidChangeConfiguration(onConfigChange),
    vscode.commands.registerCommand(
      "nix-ide.restartLanguageServer",
      restartServices,
    ),
  );
  await scheduleReconcile();
}

export async function deactivate(): Promise<void> {
  deactivating = true;
  await transition;
  await client.deactivate();
  stopFallbackServices();
}
