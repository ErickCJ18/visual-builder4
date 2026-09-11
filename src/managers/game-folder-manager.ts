import { Singleton, StorageKey, isFileExists, resolveExeName } from '@utils';
import { LocaleManager } from '@i18n';
import * as path from 'path';
import * as vscode from 'vscode';
import { GtaVersionManager } from './gta-version-manager';
import { StorageDataManager } from './storage-data-manager';

export class GameFolderManager extends Singleton {
    private context!: vscode.ExtensionContext;
    private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
    private storageDataManager: StorageDataManager = StorageDataManager.getInstance();

    public init(context: vscode.ExtensionContext) {
        this.context = context;
        this.registerCommand();
    }

    public getStoredPath(): string | undefined {
        return this.storageDataManager.get(StorageKey.GameFolderPath) as string | undefined;
    }

    async showErrorMessageSelectGameFolder() {
        const actionLabel = LocaleManager.getInstance().t('gf.selectLabelAction');

        const action = await vscode.window.showErrorMessage(
            LocaleManager.getInstance().t('gf.notConfigured'),
            actionLabel
        );

        if (action === actionLabel) {
            await vscode.commands.executeCommand('sb4.selectGameFolder');
        }
    }

    private registerCommand() {
        const disposable = vscode.commands.registerCommand(
            'sb4.selectGameFolder',
            async () => this.selectFolderHandler()
        );

        this.context.subscriptions.push(disposable);
    }

    private async selectFolderHandler() {
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: LocaleManager.getInstance().t('gf.selectLabelAction')
        });

        if (!folderUri?.[0]) {
            return;
        }

        const folderPath = folderUri[0].fsPath;
        const exe = this.resolveGameExe();

        if (!await this.validateFolder(folderPath, exe)) {
            return;
        }

        await this.storageDataManager.set(StorageKey.GameFolderPath, folderPath);
        await vscode.window.showInformationMessage(LocaleManager.getInstance().t('gf.selectedOk', { exe }));
    }

    private resolveGameExe(): string {
        return resolveExeName(this.gtaVersionManager.getIdentifier() ?? '');
    }

    private async validateFolder(folderPath: string, exe: string): Promise<boolean> {
        const exePath = path.join(folderPath, `${exe}.exe`);
        if (!await isFileExists(exePath)) {
            vscode.window.showErrorMessage(LocaleManager.getInstance().t('gf.exeMissing', { exe: `${exe}.exe` }));
            return false;
        }
        return true;
    }
}