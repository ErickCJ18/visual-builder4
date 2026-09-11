import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocaleManager } from '@i18n';

export interface WebViewHandler {
    command: string;
    data: any;
    scrollToTop: boolean;
};

export class WebViewManager {
    private panel: vscode.WebviewPanel | undefined;

    constructor(private context: vscode.ExtensionContext, private basePath: string) { }

    public createPanel(viewId: string, title: string, iconPath?: vscode.Uri, viewColumn: vscode.ViewColumn = vscode.ViewColumn.One): void {
        this.panel = vscode.window.createWebviewPanel(
            viewId,
            title,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, this.basePath))
                ]
            }
        );

        this.loadTemplate();

        this.panel.onDidDispose(() => {
            this.dispose();
        });

        if (iconPath) {
            this.panel.iconPath = {
                light: iconPath,
                dark: iconPath
            };
        }
    }

    private async loadTemplate() {
        if (this.isPanelDisposed()) {
            return;
        }

        const templatePath = path.join(
            this.context.extensionPath,
            this.basePath,
            'index.html'
        );

        let htmlContent = await fsp.readFile(templatePath, 'utf-8');

        const localeScript = `window.VB4_LOCALE = ${JSON.stringify(LocaleManager.getInstance().getCatalog())};`;

        htmlContent = htmlContent
            .replace(/{{cssUri}}/g, this.getResourceUri('styles.css'))
            .replace(/{{jsUri}}/g, this.getResourceUri('script.js'))
            .replace(/{{localeScript}}/g, localeScript);

        this.panel!.webview.html = htmlContent;
    }

    public registerMessageHandler(handler: (message: any) => void) {
        this.panel?.webview.onDidReceiveMessage(handler);
    }

    public registerChangeViewStateHandler(handler: (event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void) {
        this.panel?.onDidChangeViewState(handler);
    }

    public sendMessage(message: WebViewHandler) {
        this.panel?.webview.postMessage(message);
    }

    public getFileUri(path: string): vscode.Uri {
        return vscode.Uri.file(path);
    }

    private getResourceUri(fileName: string): string {
        return this.panel!.webview.asWebviewUri(
            this.getFileUri(path.join(this.context.extensionPath, this.basePath, fileName))
        ).toString();
    }

    public isPanelDisposed(): boolean {
        return !this.panel;
    }

    public dispose() {
        this.panel?.dispose();
        this.panel = undefined;
    }
}