import { CommandManager, FolderManager, GtaVersionManager, LanguageManager, StorageDataManager } from '@managers';
import { BaseProvider, ClassProvider, CommandFormatterProvider, DefinitionSearch, EnumProvider, JumpIncludeProvider, LoopWaitDiagnostics, OpcodeProvider, OpcodesSearch, ReferenceSearch } from '@providers';
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

    JumpIncludeProvider.getInstance().register();
    LoopWaitDiagnostics.getInstance().register();

    await EnumProvider.getInstance().init();
    ClassProvider.getInstance().init();
    OpcodeProvider.getInstance().init();

    DefinitionSearch.getInstance().init();
    ReferenceSearch.getInstance().init();
    OpcodesSearch.getInstance().create();
}