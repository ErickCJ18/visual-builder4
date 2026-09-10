import { CommandManager, GtaVersionManager, StorageDataManager } from '@managers';
import { ClassProvider, CommandFormatterProvider, EnumProvider, ModelProvider, OpcodeProvider, SyntaxColoringProvider } from '@providers';
import { CONFIG, Singleton, StorageKey } from '@utils';
import * as vscode from 'vscode';
import { GtaVersion } from '@managers';
import { OpcodesSearch } from '../providers/search/opcodes-search';

export class GtaVersionButton extends Singleton {
    private static readonly BUTTON_ID = 'sb4.gtaVersions';
    private static readonly BUTTON_TOOLTIP = 'Open GTA Versions';
    private static readonly BUTTON_TEXT_DEFAULT = 'SB4 (Select version)';
    private static readonly BUTTON_TEXT_FORMAT = (version: string) =>
        `SB4 (${version})`;

    private context!: vscode.ExtensionContext;
    private button!: vscode.StatusBarItem;
    private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
    private storageDataManager: StorageDataManager = StorageDataManager.getInstance();

    public init(context: vscode.ExtensionContext) {
        const selectedVersion = this.storageDataManager.get(StorageKey.GtaVersion) as string;

        this.context = context;
        this.button = this.createStatusBarItem();

        this.updateButtonText(selectedVersion);
        this.registerCommand();
        this.setupEditorChangeHandler();
    }

    private createStatusBarItem(): vscode.StatusBarItem {
        const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        button.tooltip = GtaVersionButton.BUTTON_TOOLTIP;
        button.command = GtaVersionButton.BUTTON_ID;
        this.context.subscriptions.push(button);
        return button;
    }

    private updateButtonText(version: string): void {
        this.button.text = version
            ? GtaVersionButton.BUTTON_TEXT_FORMAT(version)
            : GtaVersionButton.BUTTON_TEXT_DEFAULT;
    }

    private registerCommand(): void {
        const disposable = vscode.commands.registerCommand(
            GtaVersionButton.BUTTON_ID,
            async () => this.handleVersionSelection()
        );

        this.context.subscriptions.push(disposable);
    }

    public async showErrorMessageNotFoundAnyVersion() {
        await vscode.window.showErrorMessage(
            "SB4 folder doesn't contain any of GTA Version"
        );
    }

    public async handleVersionSelection() {
        let versions: GtaVersion[];

        try {
            versions = await this.gtaVersionManager.parseVersions();
        } catch (err) {
            await vscode.window.showErrorMessage(`Error reading SB4 folder: ${err}`);
            return;
        }

        if (!versions.length) {
            await this.showErrorMessageNotFoundAnyVersion();
            return;
        }

        const selected = await vscode.window.showQuickPick(versions);
        if (!selected) {
            return;
        }

        const gtaVersion = this.storageDataManager.get(StorageKey.GtaVersion) as string;

        if (selected.label === gtaVersion) {
            await vscode.window.showInformationMessage(`GTA version "${selected.label}" is already selected.`);
            return;
        }

        await this.storageDataManager.set(StorageKey.GtaVersion, selected.label);
		//await this.languageManager.updatePatterns();
		this.updateButtonText(selected.label);

		try {
			await this.reloadOpcodes();
			await OpcodesSearch.getInstance().updateWebviewContent(true);
			await vscode.window.showInformationMessage(`GTA version "${selected.label}" loaded.`);
		} catch (err) {
			await vscode.window.showErrorMessage(`Failed to load opcodes for version "${selected.label}": ${err}`);
		}
	}

	private async reloadOpcodes() {
		await CommandManager.getInstance().reload();
		CommandFormatterProvider.getInstance().reload();
		ClassProvider.getInstance().reload();
		OpcodeProvider.getInstance().reload();
		await EnumProvider.getInstance().reload();
		await ModelProvider.getInstance().reload();
		await SyntaxColoringProvider.getInstance().reload();
	}

    private setupEditorChangeHandler(): void {
        const updateVisibility = (editor: vscode.TextEditor | undefined) => {
            const isSbFile = editor?.document && vscode.languages.match(CONFIG.LANGUAGE_SELECTOR, editor.document);
            this.button[isSbFile ? 'show' : 'hide']();
        };

        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(updateVisibility),
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (vscode.window.activeTextEditor?.document === doc) {
                    updateVisibility(vscode.window.activeTextEditor);
                }
            })
        );

        updateVisibility(vscode.window.activeTextEditor);
    }
}