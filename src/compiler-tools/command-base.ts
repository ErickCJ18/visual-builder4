import { isBinaryFile, isFileExists, Singleton, StorageKey } from '@utils';
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FolderManager, GtaVersionManager, StorageDataManager } from '@managers';
import { LocaleManager } from '@i18n';
import { SyntaxColoringProvider } from '@providers';
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
			filters: { [this.t('cb.filterCompiled')]: ['scm', 'cs', 'cs3', 'cs4', 's', 'cm', 'csa', 'csi'] }
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
    // La tab sin nombre ya se sustituyó por la pestaña virtual ANTES de
    // compilar (swap temprano tras el diálogo de guardado): el cierre del
    // resultado no debe volver a tocar el tab anterior.
    private temporarySourceSwapped = false;

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
        this.temporarySourceSwapped = false;

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
                    filters: { [this.t('cb.filterCompiled')]: ['scm', 'cs', 'cs3', 'cs4', 's', 'cm', 'csa', 'csi'] }
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

				// Swap TEMPRANO: en este punto la tab sin nombre es la que
				// acaba de quedar activa tras el diálogo, así que limpiarla
				// con undo es fiable y el cierre no pregunta por guardar.
				// Además el usuario ve "main.scm" desde el inicio (mientras
				// compila) en vez de esperar al resultado.
				await this.swapUntitledToVirtualTab(editor, outputUri.fsPath);
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

				// sanny sale ANTES de terminar de escribir: el .txt puede
				// tardar ~1s en aparecer tras el cierre del proceso.
				const baseName = path.basename(filePath, path.extname(filePath));
				await this.waitForWrite([path.join(path.dirname(filePath), `${baseName}.txt`)]);

				this.diagnosticCollection?.clear();
				vscode.window.showInformationMessage(`✅ ${this.t(executeOptions.successMessage)}${elapsed}`);
				await this.showSuccessOutput(filePath, outputPath, swapActiveTab);
			} else {
				// COMPILE: sanny sale del proceso en ~30ms pero recién escribe
				// los archivos a los ~900ms, y NO siempre genera compile.log en
				// éxito (a veces solo existe el .cs/.scm). Evaluar por
				// EVIDENCIA, no por la presencia del log.
				const executeOptions = this.executeOptions[this.executeType];
				const elapsed = ` ${this.formatElapsed(Date.now() - started)}`;
				const target = outputPath ? ` → ${path.basename(outputPath)}` : '';

				const arrived = await this.waitForWrite([logPath, ...(outputPath ? [outputPath] : [])], 10000);

				if (arrived.includes(logPath)) {
					const content = await this.readLogFile(logPath).catch(() => '');
					if (content.trim() !== '') {
						this.diagnosticCollection?.set(vscode.Uri.file(filePath),
							this.compilerTools.createFileLevelDiagnostics(content));
						vscode.window.showErrorMessage(`${this.t(executeOptions.errorMessagePrefix)}${elapsed}:\n${content}`);
						return;
					}
				}

				if (outputPath && !arrived.includes(outputPath)) {
					vscode.window.showErrorMessage(`${this.t(executeOptions.errorMessagePrefix)}${elapsed}: ${this.t('cb.noOutput')}`);
					return;
				}

				this.diagnosticCollection?.clear();
				vscode.window.showInformationMessage(`✅ ${this.t(executeOptions.successMessage)}${elapsed}${target}`);
				await this.showSuccessOutput(filePath, outputPath, swapActiveTab);
			}

		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(this.t('cb.readLogFailed', { message }));
			this.log(`handleProcessClose error: ${message}`);
		}

		resolve();
		if (logPath !== null) {
			if (await isFileExists(logPath)) {
				await fsp.unlink(logPath);
			}
		}

	}

	/**
	 * Espera (polling) hasta que exista uno de los paths dados o venza el
	 * timeout. Sanny Builder sale del proceso antes de escribir sus archivos
	 * (~1s de demora), así que `close` no es señal de fin de escritura.
	 * Devuelve las rutas que llegaron a existir.
	 */
	private async waitForWrite(paths: string[], timeoutMs = 5000): Promise<string[]> {
		const matched = new Set<string>();
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			for (const filePath of paths) {
				if (!matched.has(filePath) && await isFileExists(filePath)) {
					matched.add(filePath);
				}
			}
			if (matched.size === paths.length) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 40));
		}

		return [...matched];
	}

	private async readLogFile(logPath: string): Promise<string> {
		const buffer = await fsp.readFile(logPath);
		return iconv.decode(buffer, 'win1251');
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

		// El swap temprano (tab sin nombre) ya sustituyó la pestaña durante el
		// diálogo de guardado; al terminar la compilación no se vuelve a tocar.
		if (this.temporarySourceSwapped) {
			this.log('swap temprano ya hecho: no se vuelve a tocar pestañas');
			return;
		}

		// El compilado (.scm/.cs) es binario: VS Code no lo abre como texto.
		// En lugar de eso se abre una pestaña VIRTUAL titulada como el destino
		// (main.scm) con el código que se estaba compilando (tab sin nombre:
		// el contenido temporal; fuente físico: el contenido en disco); el
		// binario real queda intacto.
		if (await isBinaryFile(outputPath)) {
			this.log(`output is binary (${path.basename(outputPath)}), using virtual tab`);

			let virtualContent = this.temporarySourceContent;
			if (virtualContent === undefined && sourcePath) {
				virtualContent = await fsp.readFile(sourcePath, 'utf-8').catch(() => undefined);
			}

			if (virtualContent !== undefined) {
				const virtualUri = vscode.Uri.from({ scheme: SB4_VIRTUAL_SCHEME, path: `/${path.basename(outputPath)}` });
				this.virtualDocProvider.setContent(virtualUri, virtualContent);
				this.log(`opening virtual tab ${virtualUri.toString()}`);

				// Cerrar PRIMERO la pestaña del fuente/sin nombre SIN diálogo:
				// una tab untitled está sucia y cerrarla preguntaría por guardar
				// y volvería el foco a ella. Como aquí AÚN es la pestaña activa,
				// se deshacen sus cambios hasta dejarla limpia (el contenido
				// real ya quedó en la pestaña virtual) y se cierra en silencio;
				// luego se abre main.scm: queda UNA sola pestaña, sin saltos.
				const sourceTabs = this.findSourceOrUntitledTabs(sourceUri, outputUri, editor, swapActiveTab);
				for (const tab of sourceTabs) {
					await this.closeTabSilently(tab);
				}

				try {
					const document = await vscode.workspace.openTextDocument(virtualUri);
					await vscode.window.showTextDocument(document, {
						preview: false,
						viewColumn: editor?.viewColumn ?? vscode.ViewColumn.Active
					});
					void vscode.languages.setTextDocumentLanguage(document, 'sannybuilder').then(() => {
					const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
					if (editor) {
						SyntaxColoringProvider.getInstance().applyToEditor(editor);
					}
				}, () => { });
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

	/**
	 * Swap temprano de la tab sin nombre hacia la pestaña virtual del
	 * compilado. Se ejecuta justo después de que el usuario elige el destino
	 * en el diálogo de guardado: ahí la tab sin nombre es 100% la activa, así
	 * que `closeTabSilently` la limpia (vacía el buffer) con total fiabilidad
	 * y luego se abre main.scm de inmediato (el usuario ve su código mientras
	 * sanny compila en paralelo).
	 */
	private async swapUntitledToVirtualTab(editor: vscode.TextEditor, outputPath: string) {
		const virtualUri = vscode.Uri.from({ scheme: SB4_VIRTUAL_SCHEME, path: `/${path.basename(outputPath)}` });

		const tab = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === editor.document.uri.toString());

		this.virtualDocProvider.setContent(virtualUri, editor.document.getText());
		this.log(`early swap: closing source tab, opening virtual ${virtualUri.toString()}`);

		// Se limpia/cierra la previa MIENTRAS la tab sigue activa: el vaciado
		// del buffer solo voltea `tab.isDirty` en el workbench con la tab en
		// foco. El cierre es fuego-y-olvido (la disposición del untitled cuesta
		// ~2.5s) y la virtual se abre al instante después.
		if (tab) {
			await this.closeTabSilently(tab, true, true);
		}

		try {
			const document = await vscode.workspace.openTextDocument(virtualUri);
			await vscode.window.showTextDocument(document, {
				preview: false,
				viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active
			});
			void vscode.languages.setTextDocumentLanguage(document, 'sannybuilder').then(() => {
					const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
					if (editor) {
						SyntaxColoringProvider.getInstance().applyToEditor(editor);
					}
				}, () => { });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showWarningMessage(this.t('cb.openCompiledTabFailed', { message }));
			this.log(`open virtual tab ERROR: ${message}`);
		}

		this.temporarySourceSwapped = true;
	}

	/**
	 * Cierra una tab SIN el diálogo de guardado:
	 * - `file` (fuente físico) ya viene limpio de `execute()` → cierre directo.
	 * - `untitled` / virtual sucia: 1) se VACÍA el buffer con un edit (el
	 *   modelo untitled marca limpio cuando queda en UNA línea de 0 chars →
	 *   `tabGroups.close` no pregunta); 2) si aún quedara sucia, undo hasta
	 *   vaciar (fallback histórico). Se audita contra `tab.isDirty` (estado
	 *   real del workbench, que puede diferir del `doc.isDirty` de la API).
	 * GARANTÍA: si la tab sigue sucia tras limpiar, NO se cierra (evita el
	 * diálogo), se conserva la pestaña y se avisa. El contenido ya está a
	 * salvo en la pestaña virtual / archivo temporal. Con `forceFocus` la tab
	 * se enfoca explícitamente antes de limpiar (útil para el swap temprano).
	 * Con `fireClose` el cierre se dispara SIN esperarlo (la disposición del
	 * editor untitled cuesta ~2.5s en el workbench; se abre la virtual en
	 * paralelo mientras la previa se cierra sola en background).
	 */
	private async closeTabSilently(tab: vscode.Tab, forceFocus = false, fireClose = false): Promise<void> {
		const input = tab.input;

		let uri: vscode.Uri | undefined;
		if (input instanceof vscode.TabInputText) {
			uri = input.uri;
		}

		if (uri && uri.scheme !== 'file') {
			try {
				const activeDoc = vscode.window.activeTextEditor?.document;
				const doc = (activeDoc && activeDoc.uri.toString() === uri.toString())
					? activeDoc
					: await vscode.workspace.openTextDocument(uri);

				let active = vscode.window.activeTextEditor?.document.uri.toString() === uri.toString();
				// El flip de `tab.isDirty` exige foco: si la tab objetivo está
				// sucia pero no es la activa y pedimos forceFocus, la enfocamos.
				if ((tab.isDirty || doc.isDirty) && !active && forceFocus) {
					await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
					active = true;
				}
				this.log(`closeTabSilently: scheme=${uri.scheme} docDirty=${doc.isDirty} tabDirty=${tab.isDirty} active=${active}`);

				if (doc.isDirty || tab.isDirty) {
					// VACIAR el buffer con un edit sobre la doc (funciona aunque
					// la tab NO sea la activa): en la práctica (tab atada a un
					// input stale restaurado) este edit es el que pone
					// `tab.isDirty` en false en el workbench → cierre sin diálogo.
					const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
					if (tab.isDirty && editor) {
						const range = new vscode.Range(
							doc.positionAt(0),
							doc.positionAt(doc.getText().length)
						);
						await editor.edit(edit => edit.delete(range));
					}
					if (tab.isDirty) {
						this.log(`closeTabSilently: after clear, docDirty=${doc.isDirty} tabDirty=${tab.isDirty}`);

						// Fallback undo SOLO si la tab sigue sucia Y es la activa
						// (el comando undo opera sobre el editor enfocado; si la
						// virtual ya tomó el foco, no aplica). El docDirty de la
						// API es irrelevante para el diálogo (evidencia: quedó
						// true y el cierre fue igualmente silencioso). Tope corto.
						let guard = 0;
						while (tab.isDirty && vscode.window.activeTextEditor?.document.uri.toString() === uri.toString() && guard < 30) {
							await vscode.commands.executeCommand('undo');
							await new Promise(resolve => setTimeout(resolve, 5));
							guard++;
						}
						if (guard > 0 || tab.isDirty) {
							this.log(`closeTabSilently: undo fallback guard=${guard} tabDirty=${tab.isDirty}`);
						}
					}
				}

				// NUNCA cerrar con el diálogo de guardado: si el workbench aún la
				// ve sucia, se conserva la tab (el código ya está a salvo en la
				// pestaña virtual / archivo temporal) y se avisa al usuario.
				if (tab.isDirty) {
					this.log(`closeTabSilently: TAB SIGUE SUCIA (tabDirty=true), se conserva la pestaña`);
					vscode.window.showWarningMessage(this.t('cb.keepTabInsteadOfPrompt'));
					return;
				}
			} catch (err) {
				this.log(`closeTabSilently cleanup error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		try {
			const closeTask = vscode.window.tabGroups.close(tab, true);
			if (fireClose) {
				// El cierre del editor untitled cuesta ~2.5s en el workbench
				// (disposición del modelo, hot-exit). No lo esperamos: la
				// virtual se abre YA y en paralelo la previa cierra sola.
				this.log('closeTabSilently: tab close initiated (fuego y olvido)');
				void closeTask.then(
					ok => this.log(`closeTabSilently: background close done, ok=${ok}`),
					err => this.log(`closeTabSilently close error (fuego y olvido): ${err instanceof Error ? err.message : String(err)}`)
				);
			} else {
				await closeTask;
				this.log('closeTabSilently: tab closed via tabGroups.close');
			}
		} catch (err) {
			this.log(`closeTabSilently close error: ${err instanceof Error ? err.message : String(err)}`);
		}
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
}