import { CommandManager, FolderManager, GtaVersionManager, LanguageManager, StorageDataManager, SyntaxColorManager } from '@managers';
import { BaseProvider, ClassProvider, CoordsProvider, CommandFormatterProvider, DefinitionSearch, EnumProvider, JumpIncludeProvider, LoopWaitDiagnostics, ModelProvider, OpcodeProvider, OpcodesSearch, ReferenceSearch, SnippetCompletionProvider, SyntaxColoringProvider } from '@providers';
import * as vscode from 'vscode';
import { CompileCommand } from './compiler-tools/compile-command';
import { DecompileCommand } from './compiler-tools/decompile-command';
import { GtaVersionButton } from './components/gta-version-button.component';

export async function activate(context: vscode.ExtensionContext) {
    StorageDataManager.getInstance().init(context);
    await GtaVersionManager.getInstance().init();
    await CommandManager.getInstance().init();
    CommandFormatterProvider.getInstance().init();
    FolderManager.getInstance().init(context);
    GtaVersionButton.getInstance().init(context);
    LanguageManager.getInstance().init(context);
    CompileCommand.getInstance().init(context);
    DecompileCommand.getInstance().init(context);

    BaseProvider.getInstance().init(context);

    vscode.commands.registerCommand('sb4.selectVersion', () => GtaVersionButton.getInstance().handleVersionSelection());

    JumpIncludeProvider.getInstance().register();
    LoopWaitDiagnostics.getInstance().register();
    await CoordsProvider.getInstance().init(context).register();

await EnumProvider.getInstance().init();
	ClassProvider.getInstance().init();
	OpcodeProvider.getInstance().init();
	SnippetCompletionProvider.getInstance().register();
	await ModelProvider.getInstance().init();

    await SyntaxColoringProvider.getInstance().init();
    vscode.commands.registerCommand('sb4.reloadColors', () => SyntaxColoringProvider.getInstance().reload());
    vscode.commands.registerCommand('sb4.customizeColors', () => SyntaxColorManager.getInstance().customizeColors());

    DefinitionSearch.getInstance().init();
    ReferenceSearch.getInstance().init();
    OpcodesSearch.getInstance().create();
}