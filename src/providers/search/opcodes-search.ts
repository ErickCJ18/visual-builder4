import { CommandManager, FolderManager, GtaVersionManager, StorageDataManager, WebViewHandler, WebViewManager } from '@managers';
import { BaseProvider } from '@providers';
import { Command, CommandType, MessageCommand, SEARCH_TYPE, Singleton, StorageKey } from '@utils';
import { LocaleManager } from '@i18n';
import * as vscode from 'vscode';
import { GtaVersionButton } from '../../components/gta-version-button.component';

export class OpcodesSearch extends Singleton {
    private webViewManager!: WebViewManager;
    private folderManager: FolderManager = FolderManager.getInstance();
    private storageDataManager: StorageDataManager = StorageDataManager.getInstance();
    private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
    private commandManager: CommandManager = CommandManager.getInstance();
    private baseProvider: BaseProvider = BaseProvider.getInstance();
    private commandType: CommandType = CommandType.OPCODE;

    public create() {
        const disposable = vscode.commands.registerCommand('sb4.searchOpcodes', async () => {
            if (!this.storageDataManager.has(StorageKey.Sb4FolderPath)) {
                this.folderManager.showErrorMessageSelectFolder();
                return;
            }

            if (!this.gtaVersionManager.hasVersionDataExists()) {
                GtaVersionButton.getInstance().showErrorMessageNotFoundAnyVersion();
                return;
            }

            this.webViewManager = new WebViewManager(this.baseProvider.context, 'src/views/opcodes');

            const iconPath = this.webViewManager.getFileUri(this.baseProvider.context.asAbsolutePath('images/logo.jpg'));

            this.webViewManager.createPanel('opcodes-view', LocaleManager.getInstance().t('ow.panelTitle'), iconPath);

            this.setupWebViewHandlers();
            await this.updateWebviewContent();
        });

        this.baseProvider.context.subscriptions.push(disposable);
    }

    private setupWebViewHandlers() {
        this.webViewManager.registerMessageHandler(async message => {
            switch (message.command) {
                case MessageCommand.UPDATE_SEARCH_TYPE:
                    this.commandType = this.getNormalizedSearchType(message.type);
                    await this.updateWebviewContent();
                    break;
            }
        });

        this.webViewManager.registerChangeViewStateHandler(async event => {
            if (event.webviewPanel.visible) {
                await this.updateWebviewContent();
            }
        });
    }

    public async updateWebviewContent(scrollToTop: boolean = false) {
        if (this.webViewManager === undefined || this.webViewManager.isPanelDisposed()) {
            return;
        }

        const content = this.getContent();

        const message: WebViewHandler = {
            command: 'updateOpcodes',
            data: content,
            scrollToTop: scrollToTop
        };

        this.webViewManager.sendMessage(message);
    }

    private getContent(): string {
        const commands: ReadonlyMap<string, Command> = this.commandManager.getCommands();

        return Array.from(commands.values())
            .filter(command => command.format?.[this.commandType] !== undefined)
            .map((command) => {
                let commandFormat = command.format?.[this.commandType];

                if (command.attrs?.isUnsupported || command.attrs?.isNop) {
                    commandFormat = `<s>${commandFormat}</s>`;
                }

                return `<div class="opcode-item">${commandFormat}</div>`;
            }).join('');
    }

    private getNormalizedSearchType(source: string): CommandType {
        return SEARCH_TYPE[source];
    }
}