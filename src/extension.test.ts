import assert = require("node:assert");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

import * as vscode from "vscode";

const readEvents = (logFile: string): string[] => {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((event) => event.length > 0);
};

const waitForEventCount = async (
  logFile: string,
  event: string,
  count: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const actual = readEvents(logFile).filter(
      (loggedEvent) => loggedEvent === event,
    ).length;
    if (actual >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${count} ${event} events`);
};

describe("Language service lifecycle", () => {
  const extension = vscode.extensions.getExtension("jnoortheen.nix-ide");
  if (!extension) {
    assert.fail("Extension not found");
  }
  const logFile = path.join(
    os.tmpdir(),
    `vscode-nix-ide-lsp-${process.pid}.log`,
  );
  const configuration = vscode.workspace.getConfiguration("nix");

  before(async () => {
    await configuration.update(
      "serverPath",
      ["node", path.join(extension.extensionPath, "test/lsp-server.js"), logFile],
      vscode.ConfigurationTarget.Global,
    );
    await configuration.update(
      "enableLanguageServer",
      true,
      vscode.ConfigurationTarget.Global,
    );
    await extension.activate();
    await waitForEventCount(logFile, "start", 1);
  });

  after(() => {
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }
  });

  it("restarts and switches from LSP to fallback services", async () => {
    await Promise.all([
      vscode.commands.executeCommand("nix-ide.restartLanguageServer"),
      vscode.commands.executeCommand("nix-ide.restartLanguageServer"),
    ]);
    await waitForEventCount(logFile, "stop", 2);
    await waitForEventCount(logFile, "start", 3);

    await configuration.update(
      "enableLanguageServer",
      false,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand("nix-ide.restartLanguageServer");
    await waitForEventCount(logFile, "stop", 3);
  });
});
