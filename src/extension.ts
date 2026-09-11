import { CommandManager, FolderManager, GtaVersionManager, LanguageManager, StorageDataManager, SyntaxColorManager } from '@managers';
import { BaseProvider, ClassProvider, CoordsProvider, CommandFormatterProvider, DefinitionSearch, EnumProvider, JumpIncludeProvider, LoopWaitDiagnostics, ModelProvider, OpcodeProvider, OpcodesSearch, ReferenceSearch, SyntaxColoringProvider } from '@providers';
import { LocaleManager } from '@i18n';
import * as vscode from 'vscode';
import { CompileCommand } from './compiler-tools/compile-command';
import { DecompileCommand } from './compiler-tools/decompile-command';
import { DeveloperTools } from './compiler-tools/developer-tools';
import { GtaVersionButton } from './components/gta-version-button.component';
import { VirtualDocumentProvider } from './components/virtual-document-provider.component';
import { openThemeCreator } from './components/theme-creator';

export async function activate(context: vscode.ExtensionContext) {
    await LocaleManager.getInstance().init(context);
    StorageDataManager.getInstance().init(context);
    await GtaVersionManager.getInstance().init();
    await CommandManager.getInstance().init();
    CommandFormatterProvider.getInstance().init();
    FolderManager.getInstance().init(context);
    GtaVersionButton.getInstance().init(context);
    LanguageManager.getInstance().init(context);
    VirtualDocumentProvider.getInstance().init(context);
    CompileCommand.getInstance().init(context);
    DecompileCommand.getInstance().init(context);
    DeveloperTools.getInstance().init(context);

    BaseProvider.getInstance().init(context);

    vscode.commands.registerCommand('sb4.selectVersion', () => GtaVersionButton.getInstance().handleVersionSelection());
    vscode.commands.registerCommand('sb4.selectLanguage', () => LocaleManager.getInstance().selectLanguage());
    vscode.commands.registerCommand('sb4.exportTexts', () => LocaleManager.getInstance().exportTexts());
    vscode.commands.registerCommand('sb4.importTexts', () => LocaleManager.getInstance().importTexts());

    JumpIncludeProvider.getInstance().register();
    LoopWaitDiagnostics.getInstance().register();
    await CoordsProvider.getInstance().init(context).register();

await EnumProvider.getInstance().init();
	ClassProvider.getInstance().init();
	OpcodeProvider.getInstance().init();
	await ModelProvider.getInstance().init();

    await SyntaxColoringProvider.getInstance().init();
    vscode.commands.registerCommand('sb4.reloadColors', () => SyntaxColoringProvider.getInstance().reload());
    vscode.commands.registerCommand('sb4.customizeColors', () => SyntaxColorManager.getInstance().customizeColors());
    vscode.commands.registerCommand('sb4.customizeFontStyles', () => SyntaxColorManager.getInstance().customizeFontStyles());
    vscode.commands.registerCommand('sb4.importTheme', () => SyntaxColorManager.getInstance().importTheme());
    vscode.commands.registerCommand('sb4.themeCreator', () => openThemeCreator());

    DefinitionSearch.getInstance().init();
    ReferenceSearch.getInstance().init();
    OpcodesSearch.getInstance().create();
}