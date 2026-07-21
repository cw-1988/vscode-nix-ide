import { sync as commandExistsSync } from "command-exists";
import * as vscode from "vscode";
import { Diagnostic, Disposable, type TextDocument } from "vscode";
import { runInWorkspace } from "./process-runner";

/**
 * Whether a given document is saved to disk and in Nix language.
 *
 * @param document The document to check
 * @return Whether the document is a Nix document saved to disk
 */
const isSavedDocument = (document: TextDocument): boolean =>
  !document.isDirty &&
  0 <
    vscode.languages.match(
      {
        language: "nix",
        scheme: "file",
      },
      document,
    );

interface LintErrorType {
  msg: string;
  row: number;
  col: number;
}

/**
 * Exec pattern against the given text and return an array of all matches.
 *
 * @param text The output from nix-instantiate stderr
 * @return All matches of pattern in text.
 */
const getErrors = (text: string): ReadonlyArray<LintErrorType> => {
  const results = [];
  // matches both syntax error messages, like:
  // `error: syntax error, unexpected ']', expecting ';', at /home/foo/bar/shell.nix:19:3`
  // as well as symbol error messages, like
  // `error: undefined variable 'openjdk' at /home/foo/bar/shell.nix:14:5`
  const pattern = /^error: (.+) at .+:(\d+):(\d+)$/gm;
  // We need to loop through the regexp here, so a let is required
  let match = pattern.exec(text);
  while (match !== null) {
    results.push({
      msg: match[1],
      row: Number.parseInt(match[2], 10),
      col: Number.parseInt(match[3], 10),
    });
    match = pattern.exec(text);
  }
  return results;
};

/**
 * Parse errors from output for a given document.
 *
 * @param document The document to whose contents errors refer
 * @param output The error output from shell.
 * @return An array of all diagnostics
 */
const shellOutputToDiagnostics = (
  document: TextDocument,
  output: string,
): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = [];
  for (const err of getErrors(output)) {
    const range = document.validateRange(
      new vscode.Range(err.row - 1, err.col - 2, err.row - 1, err.col + 2),
    );
    const diagnostic = new Diagnostic(range, err.msg);
    diagnostic.source = "nix";
    diagnostics.push(diagnostic);
  }
  return diagnostics;
};

// Disposing an event subscription prevents future lint requests, but it cannot
// cancel a `nix-instantiate` process already running. That distinction did not
// matter when the diagnostic collection shared the extension's full lifetime.
// Now that fallback is replaceable, an old process may finish after LSP has taken
// ownership of the document. `isActive` therefore serves as a generation token;
// results are published only while the requesting collection still owns the mode.
async function lintDocument(
  document: TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  isActive: () => boolean,
) {
  if (!isSavedDocument(document)) {
    return;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  let d: ReadonlyArray<Diagnostic>;
  try {
    const result = await runInWorkspace(workspaceFolder, [
      "nix-instantiate",
      "--parse",
      document.fileName,
    ]);
    d = shellOutputToDiagnostics(document, result.stderr);
  } catch (error) {
    if (error instanceof Error) {
      await vscode.window.showErrorMessage(error.message);
    }
    if (isActive()) {
      diagnostics.delete(document.uri);
    }
    return;
  }
  if (isActive()) {
    diagnostics.set(document.uri, d as Diagnostic[]);
  }
}

/**
 * Start linting files.
 *
 * The previous singleton and extension-context subscriptions were deliberate:
 * the singleton prevented duplicate listeners, and the context guaranteed
 * cleanup at extension shutdown. Those are strong defaults for a linter that is
 * initialized at most once.
 *
 * Mode switching changes that premise. A singleton cannot distinguish an active
 * fallback from one already replaced by LSP, and context-owned listeners cannot
 * be retired as a group before the extension unloads. Returning a disposable
 * preserves the same cleanup discipline at the shorter fallback lifetime. Its
 * owner can stop the collection and listeners together, then create a fresh
 * generation if configuration selects fallback again.
 *
 * @return A disposable that stops linting and clears its diagnostics
 */
export async function startLinting(): Promise<Disposable> {
  let active = true;
  const diagnostics = vscode.languages.createDiagnosticCollection("nix");
  const subscriptions: Disposable[] = [diagnostics];
  const lint = (document: TextDocument) =>
    lintDocument(document, diagnostics, () => active);

  // Check if nix-instantiate is available
  if (!commandExistsSync("nix-instantiate")) {
    void vscode.window.showWarningMessage(
      "nix-instantiate not found in $PATH. Linting is disabled.",
    );
  } else {
    subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(lint),
      vscode.workspace.onDidSaveTextDocument(lint),
      vscode.workspace.onDidCloseTextDocument((document) =>
        diagnostics.delete(document.uri),
      ),
    );
    for (const textDocument of vscode.workspace.textDocuments) {
      await lint(textDocument);
    }
  }

  const resources = Disposable.from(...subscriptions);
  return new Disposable(() => {
    active = false;
    resources.dispose();
  });
}
