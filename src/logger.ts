import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('OpenAI Agent');
  context.subscriptions.push(channel);
}

function timestamp(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

export function log(message: string): void {
  channel?.appendLine(`[${timestamp()}] ${message}`);
}

export function showLog(): void {
  channel?.show();
}

/** Logs an error and pops the Output channel into view so it's never silent. */
export function logError(message: string, err?: unknown): void {
  let detail = '';
  if (err instanceof Error) {
    detail = err.stack || err.message;
  } else if (typeof err === 'string') {
    detail = err;
  } else if (err !== undefined) {
    try {
      detail = JSON.stringify(err);
    } catch {
      detail = String(err);
    }
  }
  channel?.appendLine(`[${timestamp()}] ERROR: ${message}${detail ? '\n' + detail : ''}`);
  channel?.show(true);
}
