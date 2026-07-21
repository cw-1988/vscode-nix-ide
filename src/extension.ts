import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";
import * as client from "./client";
import { config } from "./configuration";
import { formattingProviders } from "./formatter";
import { startLinting } from "./linter";

/**
 * The selected runtime service has a shorter lifetime than the extension.
 *
 * The original implementation followed the natural VS Code extension model:
 * it chose LSP or fallback during activation, placed every registration in the
 * extension context, and relied on the host to dispose everything when the
 * extension unloaded. That is a simple and reliable model while the choice is
 * made once.
 *
 * Restart commands and configuration-driven mode changes make that choice
 * runtime state. `ExtensionContext.subscriptions` is intentionally append-only:
 * it can remember a new provider, but it cannot identify and retire the group
 * that represented the previous mode. The context therefore continues to hold
 * truly extension-scoped registrations, while the selected runtime mode receives
 * its own replaceable ownership handle.
 */
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

/**
 * At any point, configuration describes exactly one complete service mode.
 *
 * The earlier helpers were each responsible for one local concern—starting an
 * LSP, registering fallback providers, or restarting a server. As those paths
 * grew to support switching modes, there was no single place that could uphold
 * the system-wide invariant that LSP and fallback must not own the same document
 * at once. Bringing the transition paths together here makes teardown-first
 * ordering explicit, and turns a failed LSP start into one complete fallback mode
 * rather than a partially initialized mixture of both.
 */
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
  // The earlier handlers were sound in isolation, and their call sites read as
  // sequential operations. VS Code does not await one listener invocation before
  // delivering the next event, though, so two transitions could still interleave
  // as stop(A), stop(B), start(A), start(B). A promise tail gives the combined
  // lifecycle the ordering guarantees each helper already expected.
  const next = transition.then(reconcileServices, reconcileServices);
  // A rejected queue tail would prevent every later transition from running.
  // Failures are therefore caught only in the stored tail; `next` still reports
  // the current failure to its own caller.
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
  // Once the host begins disposing extension-scoped resources, a new runtime
  // generation would immediately outlive its foundation. Closing admission and
  // draining accepted work gives us a final known state to dispose before the
  // extension lifetime ends.
  deactivating = true;
  await transition;
  await client.deactivate();
  stopFallbackServices();
}
