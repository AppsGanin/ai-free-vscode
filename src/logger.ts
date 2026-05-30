import * as vscode from "vscode";

let _channel: vscode.OutputChannel | undefined;

export function setOutputChannel(channel: vscode.OutputChannel): void {
  _channel = channel;
}

export function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `[${ts}] ${message}`;
  _channel?.appendLine(line);
}
