// from PR of https://github.com/nix-community/vscode-nix-ide/pull/16/

import { inspect } from "node:util";
import { sync as commandExistsSync } from "command-exists";
import {
  type Disposable,
  env,
  type LogOutputChannel,
  Uri,
  window,
  workspace,
} from "vscode";
import type {
  CancellationToken,
  ConfigurationParams,
  LanguageClientOptions,
  LSPArray,
  MessageSignature,
} from "vscode-languageclient";
import {
  type Executable,
  LanguageClient,
  type ServerOptions,
} from "vscode-languageclient/node";
import { config, type UriMessageItem } from "./configuration";

class Client extends LanguageClient {
  private readonly resources: Disposable[] = [];

  addResources(...resources: Disposable[]): void {
    this.resources.push(...resources);
  }

  override handleFailedRequest<T>(
    type: MessageSignature,
    token: CancellationToken | undefined,
    error: unknown,
    defaultValue: T,
    showNotification?: boolean,
  ): T {
    if (config.hiddenErrorKinds.includes(type.method)) {
      this.outputChannel.appendLine(
        `Suppressing failed ${inspect(type.method)} notification`,
      );
      return super.handleFailedRequest(type, token, error, defaultValue, false);
    }
    return super.handleFailedRequest(
      type,
      token,
      error,
      defaultValue,
      showNotification,
    );
  }

  override async dispose(timeout?: number): Promise<void> {
    try {
      await super.dispose(timeout);
    } finally {
      for (const resource of this.resources.splice(0).reverse()) {
        resource.dispose();
      }
    }
  }
}

let client: Client | undefined;
let outputChannel: LogOutputChannel | undefined;

const defaultServerCandidates = [["nixd"], ["nil"]];

function resolveServerPath(): Array<string> {
  const configured = config.serverPath;
  if (configured.length > 0) {
    return configured;
  }

  for (const candidate of defaultServerCandidates) {
    if (commandExistsSync(candidate[0])) {
      return candidate;
    }
  }

  return ["nixd"];
}

export function getOutputChannel(): LogOutputChannel {
  outputChannel ??= window.createOutputChannel("Nix", { log: true });
  return outputChannel;
}

export async function activate(): Promise<void> {
  if (!config.LSPEnabled) {
    throw new Error("Language server is not enabled in configuration");
  }

  if (client !== undefined) {
    return;
  }

  const serverPath = resolveServerPath();

  if (!commandExistsSync(serverPath[0])) {
    const selection = await window.showErrorMessage<UriMessageItem>(
      `Command ${serverPath} not found in $PATH`,
      {
        title: "Install language server",
        uri: Uri.parse(
          "https://github.com/nix-community/vscode-nix-ide?tab=readme-ov-file#language-servers",
        ),
      },
    );
    if (selection?.uri !== undefined) {
      await env.openExternal(selection?.uri);
    }
    throw new Error(`Command ${serverPath} not found in $PATH`);
  }
  const serverExecutable: Executable = {
    command: serverPath[0],
    args: serverPath.slice(1),
  };
  const serverOptions: ServerOptions = serverExecutable;

  const nixDocumentSelector: { scheme: string; language: string }[] = [
    { scheme: "file", language: "nix" },
    { scheme: "untitled", language: "nix" },
  ];

  const logOutputChannel = getOutputChannel();
  const fileEvents = workspace.createFileSystemWatcher("**/*.nix");

  let newClient: Client;
  const clientOptions: LanguageClientOptions = {
    documentSelector: nixDocumentSelector,
    synchronize: {
      fileEvents,
      configurationSection: [config.rootSection],
    },
    outputChannel: logOutputChannel,
    middleware: {
      workspace: {
        configuration: (params: ConfigurationParams): LSPArray[] => {
          const items = params.items || [];
          const res: LSPArray = [];
          const settings = config.serverSettings;
          for (const item of items) {
            if (!item?.section) {
              continue;
            }
            const sectionSettings =
              settings[item.section as keyof typeof settings];
            if (!sectionSettings) {
              newClient.warn(
                `failed to find "${item.section}" in "nix.serverSettings"`,
              );
            }
            res.push(sectionSettings ?? null);
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return res;
        },
      },
    },
  };

  newClient = new Client("nix", "Nix", serverOptions, clientOptions);
  newClient.addResources(fileEvents);
  newClient.registerProposedFeatures();
  try {
    await newClient.start();
    client = newClient;
  } catch (error) {
    await newClient.dispose().catch(() => undefined);
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  const activeClient = client;
  client = undefined;
  await activeClient?.dispose();
}
