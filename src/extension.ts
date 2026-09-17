import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { ensureSetupFile } from './setupConfig';
import { ensureSkillsDir } from './skillManager';
import { ensureProjectMemoryTemplate } from './projectMemory';
import { initLogger, showLog, logError } from './logger';
import { registerDiffProvider } from './diffProvider';
import { initMcpServers, shutdownMcpServers } from './mcpManager';

export function activate(context: vscode.ExtensionContext) {
  initLogger(context);
  registerDiffProvider(context);

  // Create ~/.lca/setup.json with default parameters the first time the
  // extension runs. All API/behavior parameters are read from this file.
  const setupFilePath = ensureSetupFile();

  // Create ~/.lca/skills with an example skill the first time it runs.
  ensureSkillsDir();

  // Connect any configured MCP servers in the background; a failure here
  // shouldn't block the rest of the extension from working.
  initMcpServers().catch((err) => logError('Failed to initialize MCP servers', err));

  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openaiAgent.newChat', () => provider.resetConversation())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openaiAgent.openSetupFile', async () => {
      const doc = await vscode.workspace.openTextDocument(setupFilePath);
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openaiAgent.showLog', () => {
      showLog();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openaiAgent.openAgentsFile', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('Open a project folder first — AGENTS.md lives in the project root.');
        return;
      }
      const agentsPath = ensureProjectMemoryTemplate(folders[0].uri.fsPath);
      const doc = await vscode.workspace.openTextDocument(agentsPath);
      await vscode.window.showTextDocument(doc);
    })
  );
}

export async function deactivate(): Promise<void> {
  await shutdownMcpServers();
}
