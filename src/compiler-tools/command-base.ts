import { isFileExists, Singleton, StorageKey } from '@utils';
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FolderManager, GtaVersionManager, StorageDataManager } from '@managers';
import { CompilerTools } from './compiler-tools';

export enum ExecuteType {
    COMPILE,
    DECOMPILE
};

interface ExecuteInfo {
    commandName: string;
    flag: string;
    logFileName?: string;
    operationTitle: string;
    successMessage: string;
    errorMessagePrefix: string;
}

export abstract class CommandBase extends Singleton implements vscode.Disposable {

    protected abstract executeType: ExecuteType;
    private diagnosticCollection?: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private compilerTools: CompilerTools = CompilerTools.getInstance();
    private storageDataManager: StorageDataManager = StorageDataManager.getInstance();
    private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();

    private folderManager: FolderManager = FolderManager.getInstance();

    // Destino de compilación recordado por pestaña/fuente durante la sesión.
    private compileTargets = new Map<string, string>();

    private readonly executeOptions: Record<ExecuteType, ExecuteInfo> = {
        [ExecuteType.COMPILE]: {
            commandName: 'compileScript',
            flag: 'compile',
            logFileName: 'compile.log',
            operationTitle: 'Compiling',
            successMessage: 'Compiling succeeded',
            errorMessagePrefix: 'Compiling failed'
        },
        [ExecuteType.DECOMPILE]: {
            commandName: 'decompileScript',
            flag: 'decompile',
            operationTitle: 'Decompiling',
            successMessage: 'Decompile succeeded',
            errorMessagePrefix: 'Decompile failed'
        },
    };

    public init(context: vscode.ExtensionContext) {
        const commandName = this.executeOptions[this.executeType].commandName;

        this.diagnosticCollection = vscode.languages.createDiagnosticCollection(`sb4-${commandName}`);
        this.disposables.push(
            vscode.commands.registerCommand(`sb4.${commandName}`, this.execute.bind(this))
        );

        context.subscriptions.push(this);
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
        this.diagnosticCollection?.dispose();
    }

private async getCompileTarget(): Promise<{ input: string; output: string } | undefined> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('Open a script to compile (F6).');
			return;
		}

		const input = editor.document.uri.fsPath;

		// Si ya se eligió un destino para esta pestaña, no se vuelve a preguntar.
		const remembered = this.compileTargets.get(input);
		if (remembered) {
			return { input, output: remembered };
		}

		const uri = await vscode.window.showSaveDialog({
			title: 'Choose where to save the compiled script (.cs / .csm / .scm)',
			defaultUri: vscode.Uri.file(path.join(
				path.dirname(input),
				`${path.basename(input, path.extname(input))}.cs`
			)),
			filters: { 'Compiled script': ['cs', 'csm', 'scm'] }
		});

		if (!uri) {
			return;
		}

		const output = uri.fsPath;
		this.compileTargets.set(input, output);

		return { input, output };
    }

    private async getDecompileInput(): Promise<string | undefined> {
        return (await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: { 'Compiled scripts': ['scm', 'cs', 'cs3', 'cs4', 's', 'cm', 'csa', 'csi'] }
        }))?.[0].fsPath;
    }

    private getArgs(filePath: string, flag: string, outputPath?: string): string[] {
        const args = [
            '--no-splash',
            '--mode',
            this.gtaVersionManager.getIdentifier()!,
            `--${flag}`,
            filePath
        ];

        // --compile <input> [output]: el destino elegido se pasa como salida.
        if (outputPath) {
            args.push(outputPath);
        }

        return args;
    }

    private temporarySourcePath?: string;

    private async execute() {
        if (!this.storageDataManager.has(StorageKey.Sb4FolderPath)) {
            return;
        }

        let filePath: string | undefined;
        let outputPath: string | undefined;
        let swapActiveTab = false;

        if (this.executeType === ExecuteType.COMPILE) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Open a script to compile (F6).');
                return;
            }

            // Flujo estilo SB4: tab SIN NOMBRE (p.ej. pegar el código en una
            // pestaña nueva). El contenido se vuelca a un archivo temporal en
            // disco (sanny no puede leer el buffer), se compila sobre el
            // archivo que elijas (main.scm) y al terminar la pestaña se
            // reemplaza por el compilado ("el nombre del archivo en la tab").
            if (editor.document.uri.scheme !== 'file') {
                const tempSource = path.join(os.tmpdir(), `sb4-src-${process.pid}-${Date.now()}.cs`);
                await fsp.writeFile(tempSource, editor.document.getText(), 'utf-8');

                const outputUri = await vscode.window.showSaveDialog({
                    title: 'Choose where to save the compiled script (.cs / .csm / .scm)',
                    defaultUri: vscode.Uri.file(path.join(this.getWorkspaceFolder(), 'main.scm')),
                    filters: { 'Compiled script': ['cs', 'csm', 'scm'] }
                });

                if (!outputUri) {
                    await fsp.unlink(tempSource).catch(() => { });
                    return;
                }

                this.temporarySourcePath = tempSource;
                filePath = tempSource;
                outputPath = outputUri.fsPath;
                swapActiveTab = true;
            } else {
                // Compilar el contenido en disco: guardar antes si la pestaña
                // está sucia, para que sanny compile lo que se ve.
                if (editor.document.isDirty && !await editor.document.save()) {
                    return;
                }

                const target = await this.getCompileTarget();
                filePath = target?.input;
                outputPath = target?.output;
            }
        } else {
            filePath = await this.getDecompileInput();
        }

        if (!filePath) {
            return;
        }

        await this.executeOperation(filePath, outputPath, swapActiveTab);
    }

    private getWorkspaceFolder(): string {
        const folders = vscode.workspace.workspaceFolders;
        return (folders && folders.length > 0) ? folders[0].uri.fsPath : os.homedir();
    }

    private async executeOperation(filePath: string, outputPath?: string, swapActiveTab = false) {
        const folderPath = this.storageDataManager.get(StorageKey.Sb4FolderPath) as string;

        if (!folderPath) {
            this.folderManager.showErrorMessageSelectFolder();
            return;
        }

        const executeOptions = this.executeOptions[this.executeType];
        const logFileName = executeOptions.logFileName;

        const logPath = logFileName ? path.join(folderPath, logFileName) : null;
        const args = this.getArgs(filePath, executeOptions.flag, outputPath);

if (logPath !== null) {
			await fsp.unlink(logPath).catch(() => { });
		}

		const started = Date.now();

		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Window,
				title: executeOptions.operationTitle,
				cancellable: false
			}, () => this.runCompilerProcess(logPath, filePath, outputPath, folderPath, args, started, swapActiveTab));
		} finally {
			// El fuente temporal (tab sin nombre) ya no se necesita.
			if (this.temporarySourcePath) {
				await fsp.unlink(this.temporarySourcePath).catch(() => { });
				this.temporarySourcePath = undefined;
			}
		}
	}

	private formatElapsed(elapsedMs: number): string {
		if (elapsedMs >= 60000) {
			const seconds = Math.round(elapsedMs / 1000);
			return `(${Math.floor(seconds / 60)}m ${seconds % 60}s)`;
		}

		if (elapsedMs >= 1000) {
			return `(${(elapsedMs / 1000).toFixed(1)}s)`;
		}

		return `(${elapsedMs}ms)`;
	}

	private async runCompilerProcess(logPath: string | null, filePath: string, outputPath: string | undefined, folderPath: string, args: string[], started: number, swapActiveTab: boolean): Promise<void> {
		// sanny.exe no tiene modo headless (sannybuilder/dev#399): su ventana
		// puede parpadear al compilar. `windowsHide` aplica SW_HIDE vía
		// STARTUPINFO (igual que el wrapper VBS) pero sin el ~1.1s de arranque
		// de cscript.exe, así que el proceso se lanza directo y es más rápido.
		const sannyExe = path.join(folderPath, 'sanny.exe');

		return new Promise<void>((resolve, reject) => {
			const child = spawn(sannyExe, args, { windowsHide: true });

			child.on('close', () => this.handleProcessClose(logPath, filePath, outputPath, started, swapActiveTab, resolve, reject));
			child.on('error', err => this.handleProcessError(err, reject));
		});
	}

	private async handleProcessClose(logPath: string | null, filePath: string, outputPath: string | undefined, started: number, swapActiveTab: boolean, resolve: () => void, reject: (reason?: any) => void) {
		try {
			if (logPath !== null) {
				await fsp.access(logPath);

				const content = await this.readLogFile(logPath);

				this.handleLogContent(content, filePath, outputPath, Date.now() - started, swapActiveTab);
			}

		} catch (error) {
			this.handleError(error as any, filePath, outputPath, reject, Date.now() - started, swapActiveTab);
		}

		resolve();
		if (logPath !== null) {
			if (await isFileExists(logPath)) {
				await fsp.unlink(logPath);
			}
		}

	}

	private async readLogFile(logPath: string): Promise<string> {
		const buffer = await fsp.readFile(logPath);
		return iconv.decode(buffer, 'win1251');
	}

	private async handleLogContent(content: string, filePath: string, outputPath?: string, elapsedMs?: number, swapActiveTab = false) {
		const executeOptions = this.executeOptions[this.executeType];
		const elapsed = elapsedMs !== undefined ? ` ${this.formatElapsed(elapsedMs)}` : '';
		if (content === null || content.trim() === '') {
			vscode.window.showInformationMessage(`✅ ${executeOptions.successMessage}${elapsed}`);
			await this.showCompiledOutput(filePath, outputPath, swapActiveTab);
		} else {
			this.diagnosticCollection?.set(vscode.Uri.file(filePath),
				this.compilerTools.createFileLevelDiagnostics(content));
			vscode.window.showErrorMessage(`${executeOptions.errorMessagePrefix}${elapsed}:\n${content}`);
		}
	}

	/**
	 * Tras compilar con éxito, la pestaña activa pasa a mostrar el archivo
	 * compilado: se cierran la pestaña del fuente, las del destino viejo y,
	 * si el fuente era una pestaña sin nombre (swapActiveTab), esa pestaña
	 * también; después se abre el destino en su lugar.
	 */
	private async showCompiledOutput(sourcePath: string | undefined, outputPath?: string, swapActiveTab = false) {
		if (!outputPath || this.executeType !== ExecuteType.COMPILE) {
			return;
		}

		const uri = vscode.Uri.file(outputPath);
		const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;

		if (activeUri === uri.fsPath) {
			return;
		}

		const sourceUri = sourcePath ? vscode.Uri.file(sourcePath) : undefined;
		let reopened = false;

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.isDirty) {
					continue;
				}

				if (tab.input instanceof vscode.TabInputText) {
					const tabPath = tab.input.uri.fsPath;
					const isSourceTab = sourceUri && tabPath === sourceUri.fsPath;
					const isOldOutputTab = tabPath === uri.fsPath;
					const isUntitledToSwap = swapActiveTab && tab.isActive;

					if (isSourceTab || isOldOutputTab || isUntitledToSwap) {
						await vscode.window.tabGroups.close(tab, true);
						reopened = true;
					}
				}
			}
		}

		if (reopened) {
			await vscode.window.showTextDocument(uri, { preview: false });
		}
	}

    private handleProcessError(err: Error, reject: (reason?: any) => void) {
        vscode.window.showErrorMessage(`Process error: ${err.message}`);
        reject(err);
    }

private handleError(error: NodeJS.ErrnoException, filePath: string, outputPath: string | undefined, reject: (reason?: any) => void, elapsedMs?: number, swapActiveTab = false) {
		if (error.code === 'ENOENT') {
			const executeOptions = this.executeOptions[this.executeType];
			const elapsed = elapsedMs !== undefined ? ` ${this.formatElapsed(elapsedMs)}` : '';

			this.diagnosticCollection?.clear();
			vscode.window.showInformationMessage(`✅ ${executeOptions.successMessage}${elapsed}`);
			void this.showCompiledOutput(filePath, outputPath, swapActiveTab);
		} else {
            vscode.window.showErrorMessage(`Failed to read log file: ${error.message}`);
            reject(error);
        }
    }
}