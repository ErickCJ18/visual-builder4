import { CONFIG, Singleton, StorageKey, isFileExists, showInfoToast } from '@utils';
import { LocaleManager } from '@i18n';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageManager } from './language-manager';
import { StorageDataManager } from './storage-data-manager';

export class FolderManager extends Singleton {
    private context!: vscode.ExtensionContext;
    private languageManager: LanguageManager = LanguageManager.getInstance();
    private storageDataManager: StorageDataManager = StorageDataManager.getInstance();

    public init(context: vscode.ExtensionContext) {
        this.context = context;
        this.registerFolderCommand();

        if (!this.storageDataManager.has(StorageKey.Sb4FolderPath)) {
            this.showErrorMessageSelectFolder();
        }
    }

    async showErrorMessageSelectFolder() {
        const actionLabel = LocaleManager.getInstance().t('folder.selectLabelAction');

        const action = await vscode.window.showErrorMessage(
            LocaleManager.getInstance().t('folder.selectError'),
            actionLabel
        );

        if (action === actionLabel) {
            await vscode.commands.executeCommand('sb4.selectFolder');
        }
    }

    private registerFolderCommand() {
        const disposable = vscode.commands.registerCommand(
            'sb4.selectFolder',
            async () => this.selectFolderHandler()
        );

        this.context.subscriptions.push(disposable);
    }

    private async selectFolderHandler() {
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: LocaleManager.getInstance().t('folder.selectLabelAction')
        });

        if (!folderUri?.[0]) {
            return;
        }

        const folderPath = folderUri[0].fsPath;
        if (!await this.validateFolder(folderPath)) {
            return;
        }

        await this.storageDataManager.set(StorageKey.Sb4FolderPath, folderPath);
        //await this.languageManager.updatePatterns();
        await showInfoToast(LocaleManager.getInstance().t('folder.selectedOk'));
    }

    private async validateFolder(folderPath: string): Promise<boolean> {
        const exePath = path.join(folderPath, CONFIG.SANNY_EXE);
        if (!await isFileExists(exePath)) {
            vscode.window.showErrorMessage(LocaleManager.getInstance().t('folder.sannyMissing', { exe: CONFIG.SANNY_EXE }));
            return false;
        }
        return true;
    }
}