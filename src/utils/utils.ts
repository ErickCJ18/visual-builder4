import { promises as fsp } from 'fs';
import * as vscode from 'vscode';

export async function isFileExists(path: string): Promise<boolean> {
    try {
        await fsp.access(path);
        return true;
    } catch {
        return false;
    }
}

export async function showInfoToast(message: string, durationMs?: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('sb4.toast');
    if (!config.get<boolean>('autoDismiss', true)) {
        await vscode.window.showInformationMessage(message);
        return;
    }
    const ms = durationMs ?? config.get<number>('duration', 3000);
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message, cancellable: false },
        () => new Promise<void>(resolve => setTimeout(resolve, ms))
    );
}

export async function isBinaryFile(filePath: string): Promise<boolean> {
    const handle = await fsp.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).includes(0);
    } finally {
        await handle.close();
    }
}

export async function readJsonFile(filePath: string): Promise<any> {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
};

export function getDottedWordRangeAtPosition(doc: vscode.TextDocument, position: vscode.Position): vscode.Range | null {
    const line = doc.lineAt(position.line).text;
    const offset = position.character;

    const isIdentChar = (ch: string) =>
        /[A-Za-z0-9_]/.test(ch);

    let start = offset;
    let end = offset;

    while (start > 0 && (isIdentChar(line[start - 1]) || line[start - 1] === '.')) {
        start--;
    }

    while (end < line.length && (isIdentChar(line[end]) || line[end] === '.')) {
        end++;
    }

    const text = line.slice(start, end);

    if (!text.includes('.')) {
        return null;
    }

    return new vscode.Range(
        new vscode.Position(position.line, start),
        new vscode.Position(position.line, end)
    );
}
