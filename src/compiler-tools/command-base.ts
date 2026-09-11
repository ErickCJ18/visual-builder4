import { isBinaryFile, isFileExists, Singleton, StorageKey } from '@utils';
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FolderManager, GtaVersionManager, StorageDataManager } from '@managers';
import { LocaleManager } from '@i18n';
import { CompilerTools } from './compiler-tools';
import { SB4_VIRTUAL_SCHEME, VirtualDocumentProvider } from '@components';

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
    private virtualDocProvider: VirtualDocumentProvider = VirtualDocumentProvider.getInstance();

    private folderManager: FolderManager = FolderManager.getInstance();

    private t = (key: string, params?: Record<string, string>) => LocaleManager.getInstance().t(key, params);

    // Destino de compilación recordado por pestaña/fuente durante la sesión.
    private compileTargets = new Map<string, string>();

    private readonly executeOptions: Record<ExecuteType, ExecuteInfo> = {
        [ExecuteType.COMPILE]: {
            commandName: 'compileScript',
            flag: 'compile',
            logFileName: 'compile.log',
            operationTitle: 'cb.operationCompile',
            successMessage: 'cb.successCompile',
            errorMessagePrefix: 'cb.errorCompile'
        },
        [ExecuteType.DECOMPILE]: {
            commandName: 'decompileScript',
            flag: 'decompile',
            operationTitle: 'cb.operationDecompile',
            successMessage: 'cb.successDecompile',
            errorMessagePrefix: 'cb.errorDecompile'
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
        this.outputChannel?.dispose();
    }

private async getCompileTarget(): Promise<{ input: string; output: string } | undefined> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage(this.t('cb.openScript'));
			return;
		}

		const input = editor.document.uri.fsPath;

		// Si ya se eligió un destino para esta pestaña, no se vuelve a preguntar.
		const remembered = this.compileTargets.get(input);
		if (remembered) {
			return { input, output: remembered };
		}

		const baseName = path.basename(input, path.extname(input));
		const defaultExt = this.getRememberedCompileExt(path.dirname(input), baseName) ?? (/^main$/i.test(baseName) ? 'scm' : 'cs');

		const uri = await vscode.window.showSaveDialog({
			title: this.t('cb.saveTitle'),
			defaultUri: vscode.Uri.file(path.join(
				path.dirname(input),
				`${baseName}.${defaultExt}`
			)),
			filters: { [this.t('cb.filterCompiled')]: ['cs', 'csm', 'scm'] }
		});

		if (!uri) {
			return;
		}

		const output = uri.fsPath;
		this.compileTargets.set(input, output);
		await this.rememberCompileExt(path.dirname(output), baseName, path.extname(output).replace(/^\./, ''));

		return { input, output };
    }

    private async getDecompileInput(): Promise<string | undefined> {
        return (await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: { [this.t('cb.filterDecompiled')]: ['scm', 'cs', 'cs3', 'cs4', 's', 'cm', 'csa', 'csi'] }
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
    private temporarySourceContent?: string;

    private getRememberedCompileExt(dir: string, name: string): string | undefined {
        return this.storageDataManager.get<Record<string, string>>(StorageKey.CompileExtPref)?.[this.compilePrefKey(dir, name)];
    }

    private compilePrefKey(dir: string, name: string): string {
        return `${dir.toLowerCase()}${path.sep}${name.toLowerCase()}`;
    }

    private async rememberCompileExt(dir: string, name: string, ext: string) {
        if (!ext) {
            return;
        }
        const prefs = this.storageDataManager.get<Record<string, string>>(StorageKey.CompileExtPref) ?? {};
        prefs[this.compilePrefKey(dir, name)] = ext;
        await this.storageDataManager.set(StorageKey.CompileExtPref, prefs);
    }

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
                vscode.window.showErrorMessage(this.t('cb.openScript'));
                return;
            }

            // Flujo estilo SB4: tab SIN NOMBRE (p.ej. pegar el código en una
            // pestaña nueva). El contenido se vuelca a un archivo temporal en
            // disco (sanny no puede leer el buffer), se compila sobre el
            // archivo que elijas (main.scm) y al terminar la pestaña se
            // reemplaza por el compilado ("el nombre del archivo en la tab").
            if (editor.document.uri.scheme !== 'file') {
                const tempSource = path.join(os.tmpdir(), `sb4-src-${process.pid}-${Date.now()}.sb`);
                this.temporarySourceContent = editor.document.getText();
                await fsp.writeFile(tempSource, this.temporarySourceContent, 'utf-8');

                const outputUri = await vscode.window.showSaveDialog({
                    title: this.t('cb.saveTitle'),
                    defaultUri: vscode.Uri.file(path.join(this.getWorkspaceFolder(), 'main.scm')),
                    filters: { [this.t('cb.filterCompiled')]: ['cs', 'csm', 'scm'] }
                });

                if (!outputUri) {
                    await fsp.unlink(tempSource).catch(() => { });
                    return;
                }

this.temporarySourcePath = tempSource;
				filePath = tempSource;
				outputPath = outputUri.fsPath;
				swapActiveTab = true;
				await this.rememberCompileExt(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)), path.extname(outputPath).replace(/^\./, ''));
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
				title: this.t(executeOptions.operationTitle),
				cancellable: false
			}, () => this.runCompilerProcess(logPath, filePath, outputPath, folderPath, args, started, swapActiveTab));
		} finally {
			// El fuente temporal (tab sin nombre) ya no se necesita: el
			// contenido quedó en la pestaña virtual del compilado.
			if (this.temporarySourcePath) {
				await fsp.unlink(this.temporarySourcePath).catch(() => { });
				this.temporarySourcePath = undefined;
				this.temporarySourceContent = undefined;
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
			if (logPath === null) {
				// DECOMPILE: sanny no escribe compile.log; la ventana Report
				// indica el resultado, así que la salida limpia = éxito.
				const executeOptions = this.executeOptions[this.executeType];
				const elapsed = ` ${this.formatElapsed(Date.now() - started)}`;

				this.diagnosticCollection?.clear();
				vscode.window.showInformationMessage(`✅ ${this.t(executeOptions.successMessage)}${elapsed}`);
				await this.showSuccessOutput(filePath, outputPath, swapActiveTab);
			} else {
				await fsp.access(logPath);

				const content = await this.readLogFile(logPath);

				await this.handleLogContent(content, filePath, outputPath, Date.now() - started, swapActiveTab);
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
		const target = this.executeType === ExecuteType.COMPILE && outputPath ? ` → ${path.basename(outputPath)}` : '';
		if (content === null || content.trim() === '') {
			vscode.window.showInformationMessage(`✅ ${this.t(executeOptions.successMessage)}${elapsed}${target}`);
			await this.showSuccessOutput(filePath, outputPath, swapActiveTab);
		} else {
			this.diagnosticCollection?.set(vscode.Uri.file(filePath),
				this.compilerTools.createFileLevelDiagnostics(content));
			vscode.window.showErrorMessage(`${this.t(executeOptions.errorMessagePrefix)}${elapsed}:\n${content}`);
		}
	}

	/**
	 * Abre el resultado de la operación al terminar con éxito:
	 * - COMPILE: el archivo compilado (reemplazando la pestaña del fuente).
	 * - DECOMPILE: el .txt que sanny genera junto al binario
	 *   (`<carpeta del binario>/<basename>.txt`), que antes nunca se abría.
	 */
	private async showSuccessOutput(filePath: string, outputPath?: string, swapActiveTab = false) {
		if (this.executeType === ExecuteType.COMPILE) {
			await this.showCompiledOutput(filePath, outputPath, swapActiveTab);
			return;
		}

		const baseName = path.basename(filePath, path.extname(filePath));
		const txtPath = path.join(path.dirname(filePath), `${baseName}.txt`);
		const sbPath = path.join(path.dirname(filePath), `${baseName}.sb`);

		// sanny escribe <binario>.txt; se reinterpreta como fuente .sb para
		// cerrar el ciclo: x.cs → x.sb → compilar → x.cs.
		let openPath = txtPath;
		try {
			await fsp.rename(txtPath, sbPath);
			openPath = sbPath;
			await this.rememberCompileExt(path.dirname(filePath), baseName, path.extname(filePath).replace(/^\./, ''));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log(`rename ${txtPath} → ${sbPath} failed, keeping .txt: ${message}`);
		}
		this.log(`showDecompiledOutput(${openPath})`);
		await this.openDocument(vscode.Uri.file(openPath), 'decompiled');
	}

	private async openDocument(uri: vscode.Uri, kind: string) {
		const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;
		if (activeUri === uri.fsPath) {
			return;
		}

		try {
			await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Active });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showWarningMessage(this.t('cb.openKindFailed', { kind: this.t('cb.kindDecompiled'), message }));
			this.log(`open '${kind}' ${uri.fsPath} ERROR: ${message}`);
		}
	}

	/**
	 * Tras compilar con éxito, la pestaña activa pasa a mostrar el archivo
	 * compilado. Estrategia robusta:
	 *   1) Se cierran las pestañas viejas del destino (otras columnas).
	 *   2) Se ABRE el compilado primero, en la columna donde está el fuente.
	 *   3) Solo después se cierra la pestaña del fuente (ya no activa, no
	 *      rompe el foco) o la pestaña sin nombre que se está sustituyendo.
	 * Si abrir falla, el fuente NO se cierra y se muestra un warning en vez
	 * de perder la pestaña en silencio.
	 */
	private async showCompiledOutput(sourcePath: string | undefined, outputPath?: string, swapActiveTab = false) {
		this.log(`showCompiledOutput(source=${sourcePath}, out=${outputPath}, swap=${swapActiveTab})`);

		if (!outputPath || this.executeType !== ExecuteType.COMPILE) {
			return;
		}

		const outputUri = vscode.Uri.file(outputPath);
		const editor = vscode.window.activeTextEditor;
		const activeUri = editor?.document.uri.fsPath;
		const sourceUri = sourcePath ? vscode.Uri.file(sourcePath) : undefined;

		// Ya se está mostrando el compilado: no hay nada que hacer.
		if (activeUri === outputUri.fsPath) {
			this.log('already showing the compiled file, nothing to do');
			return;
		}

		// El compilado (.scm/.cs) es binario: VS Code no lo abre como texto.
		// En el flujo de tab SIN NOMBRE se abre una pestaña VIRTUAL titulada
		// como el destino (main.scm) con el código que había antes en la tab;
		// el binario en disco queda intacto.
		if (await isBinaryFile(outputPath)) {
			this.log(`output is binary (${path.basename(outputPath)}), skipping text open`);

			if (swapActiveTab && this.temporarySourceContent !== undefined) {
				const virtualUri = vscode.Uri.from({ scheme: SB4_VIRTUAL_SCHEME, path: `/${path.basename(outputPath)}` });
				this.virtualDocProvider.setContent(virtualUri, this.temporarySourceContent);
				this.log(`opening virtual tab ${virtualUri.toString()}`);

				try {
					const document = await vscode.workspace.openTextDocument(virtualUri);
					await vscode.window.showTextDocument(document, {
						preview: false,
						viewColumn: editor?.viewColumn ?? vscode.ViewColumn.Active
					});
					void vscode.languages.setTextDocumentLanguage(document, 'sannybuilder').then(undefined, () => { });

					for (const tab of this.findSourceOrUntitledTabs(sourceUri, outputUri, editor, swapActiveTab)) {
						await vscode.window.tabGroups.close(tab, true);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					vscode.window.showWarningMessage(this.t('cb.openCompiledTabFailed', { message }));
					this.log(`open virtual tab ERROR: ${message}`);
				}
				return;
			}

			try {
				await vscode.commands.executeCommand('revealInExplorer', outputUri);
			} catch (err) {
				this.log(`revealInExplorer failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}

		try {
			for (const tab of this.findOldOutputTabs(outputUri)) {
				await vscode.window.tabGroups.close(tab, true);
			}

			const column = editor?.viewColumn ?? vscode.ViewColumn.Active;
			this.log(`opening ${outputUri.fsPath} in column ${column}`);
			await vscode.window.showTextDocument(outputUri, { preview: false, viewColumn: column });

			// El fuente ya no está activo; ahora sí puede cerrarse sin romper el foco.
			for (const tab of this.findSourceOrUntitledTabs(sourceUri, outputUri, editor, swapActiveTab)) {
				await vscode.window.tabGroups.close(tab, true);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showWarningMessage(this.t('cb.openCompiledFileFailed', { message }));
			this.log(`showCompiledOutput ERROR: ${message}`);
		}
	}

	private outputChannel?: vscode.OutputChannel;

	private log(message: string) {
		if (!this.outputChannel) {
			this.outputChannel = vscode.window.createOutputChannel('VB4 Compile');
		}
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	private findOldOutputTabs(outputUri: vscode.Uri): vscode.Tab[] {
		// Pestañas limpias que ya muestran el destino (normalmente en otra columna).
		const tabs: vscode.Tab[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.isDirty) {
					continue;
				}
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === outputUri.fsPath) {
					tabs.push(tab);
				}
			}
		}
		return tabs;
	}

	private findSourceOrUntitledTabs(sourceUri: vscode.Uri | undefined, outputUri: vscode.Uri, editor: vscode.TextEditor | undefined, swapActiveTab: boolean): vscode.Tab[] {
		const activeDocUri = editor?.document.uri;

		const tabs: vscode.Tab[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText)) {
					continue;
				}
				// Nunca cerrar la pestaña del compilado recién abierto.
				if (outputUri && tab.input.uri.fsPath === outputUri.fsPath) {
					continue;
				}

				const isSourceTab = sourceUri && tab.input.uri.fsPath === sourceUri.fsPath;
				const isUntitledSwapped = swapActiveTab && activeDocUri && tab.input.uri.toString() === activeDocUri.toString();

				if (!isSourceTab && !isUntitledSwapped) {
					continue;
				}
				// La pestaña sin nombre sustituida se cierra aunque esté sucia;
				// un fuente guardado solo si está limpio.
				if (tab.isDirty && !isUntitledSwapped) {
					continue;
				}

				tabs.push(tab);
			}
		}
		return tabs;
	}

    private handleProcessError(err: Error, reject: (reason?: any) => void) {
        vscode.window.showErrorMessage(this.t('cb.processError', { message: err.message }));
        reject(err);
    }

private handleError(error: NodeJS.ErrnoException, filePath: string, outputPath: string | undefined, reject: (reason?: any) => void, elapsedMs?: number, swapActiveTab = false) {
if (error.code === 'ENOENT') {
			const executeOptions = this.executeOptions[this.executeType];
			const elapsed = elapsedMs !== undefined ? ` ${this.formatElapsed(elapsedMs)}` : '';
			const target = this.executeType === ExecuteType.COMPILE && outputPath ? ` → ${path.basename(outputPath)}` : '';

			this.diagnosticCollection?.clear();
			vscode.window.showInformationMessage(`✅ ${this.t(executeOptions.successMessage)}${elapsed}${target}`);
			void this.showSuccessOutput(filePath, outputPath, swapActiveTab);
		} else {
            vscode.window.showErrorMessage(this.t('cb.readLogFailed', { message: error.message }));
            reject(error);
        }
    }
}