import { Singleton } from '@utils';
import * as vscode from 'vscode';

export const SB4_VIRTUAL_SCHEME = 'sb4-tab';

export class VirtualDocumentProvider extends Singleton implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

    public readonly onDidChange = this.onDidChangeEmitter.event;

    public init(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            this.onDidChangeEmitter,
            vscode.workspace.registerTextDocumentContentProvider(SB4_VIRTUAL_SCHEME, this)
        );
    }

    public setContent(uri: vscode.Uri, content: string) {
        this.contents.set(uri.toString(), content);
        this.onDidChangeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }
}