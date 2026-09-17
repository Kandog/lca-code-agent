import * as vscode from 'vscode';

export const DIFF_SCHEME = 'openai-agent-diff';

const contentMap = new Map<string, string>();
let counter = 0;

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return contentMap.get(uri.toString()) ?? '';
  }
}

export function registerDiffProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new DiffContentProvider())
  );
}

function makeUri(side: 'original' | 'proposed', relPath: string, content: string): vscode.Uri {
  counter++;
  const cleanPath = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const uri = vscode.Uri.parse(`${DIFF_SCHEME}:/${side}-${counter}/${cleanPath}`);
  contentMap.set(uri.toString(), content);
  return uri;
}

const openDiffTabs = new Map<string, { original: vscode.Uri; modified: vscode.Uri }>();

/**
 * Opens a native VS Code diff editor tab (Original ↔ Proposed Changes) in the
 * main editor area — instead of
 * rendering the diff inside the sidebar chat panel. `requestId` ties this
 * tab to the approval request so it can be closed once the user decides.
 */
export async function openDiffTab(relPath: string, original: string, updated: string, requestId: string): Promise<void> {
  const originalUri = makeUri('original', relPath, original);
  const modifiedUri = makeUri('proposed', relPath, updated);
  openDiffTabs.set(requestId, { original: originalUri, modified: modifiedUri });
  const title = `${relPath}: Original ↔ Proposed Changes`;
  await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title, { preview: true });
}

/** Closes the diff tab opened for a given approval request, if it's still open. */
export async function closeDiffTab(requestId: string): Promise<void> {
  const pair = openDiffTabs.get(requestId);
  openDiffTabs.delete(requestId);
  if (!pair) return;

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        input.original.toString() === pair.original.toString() &&
        input.modified.toString() === pair.modified.toString()
      ) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          // tab may already be closed by the user - fine either way
        }
      }
    }
  }
}
