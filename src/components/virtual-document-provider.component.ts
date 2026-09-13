import { Singleton } from '@utils';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SyntaxColoringProvider } from '../providers/syntax/syntax-coloring-provider';

export const SB4_VIRTUAL_SCHEME = 'sb4-tab';

/**
 * Pestañas virtuales editables (ej. la pestaña `main.scm` que muestra el
 * fuente que se compiló).
 *
 * Se registra como `FileSystemProvider` (NO como `TextDocumentContentProvider`):
 * un esquema servido solo por content provider se abre READ-ONLY en VS Code
 * actual, y la pestaña compilada quedaría sin edición posible. Con un
 * FileSystemProvider escribible el contenido vive en memoria (mapa uri→texto),
 * se puede editar y recompilar desde la misma pestaña.
 */
export class VirtualDocumentProvider extends Singleton implements vscode.FileSystemProvider {
	private readonly contents = new Map<string, string>();
	// Destino de compilación asociado a cada pestaña virtual (uri → outputPath).
	// Persistido para que tras recargar el dev host, F6 sobre la tab restaurada
	// recompile al MISMO destino sin volver a pedir el diálogo de guardado.
	private readonly targets = new Map<string, string>();
	private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	/** Caché persistida en disco (NO en globalState: el contenido de main.scm
	 *  es ~1.5 MB y VS Code avisa `large extension state detected` por carreras
	 *  grandes de estado global en cada arranque). */
	private static readonly STATE_KEY = 'sb4Tab.virtualDocs';
	private static readonly TARGET_STATE_KEY = 'sb4Tab.virtualTargets';
	private static readonly CACHE_FILE = 'sb4-virtual-tabs.json';

	private context: vscode.ExtensionContext | undefined;
	private persistTimer: NodeJS.Timeout | undefined;

	public readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

	public init(context: vscode.ExtensionContext) {
		this.context = context;

		// Hidratar el caché: primero desde disco, y si aún no existe, migrar el
		// contenido (y destino) que la sesión anterior guardó en globalState.
		// Al migrar se borra el estado global grande: ya no se transfiere ~1.5
		// MB por IPC en cada arranque.
		const disk = this.loadFromDisk();
		if (disk) {
			for (const [uri, content] of Object.entries(disk.contents)) {
				if (typeof content === 'string') {
					this.contents.set(uri, content);
				}
			}
			for (const [uri, output] of Object.entries(disk.targets)) {
				if (typeof output === 'string') {
					this.targets.set(uri, output);
				}
			}
		} else {
			const legacyContents = context.globalState.get<Record<string, string>>(VirtualDocumentProvider.STATE_KEY);
			if (legacyContents && typeof legacyContents === 'object') {
				for (const [uri, content] of Object.entries(legacyContents)) {
					if (typeof content === 'string') {
						this.contents.set(uri, content);
					}
				}
				void context.globalState.update(VirtualDocumentProvider.STATE_KEY, undefined);
			}
			const legacyTargets = context.globalState.get<Record<string, string>>(VirtualDocumentProvider.TARGET_STATE_KEY);
			if (legacyTargets && typeof legacyTargets === 'object') {
				for (const [uri, output] of Object.entries(legacyTargets)) {
					if (typeof output === 'string') {
						this.targets.set(uri, output);
					}
				}
				void context.globalState.update(VirtualDocumentProvider.TARGET_STATE_KEY, undefined);
			}
			if (this.contents.size > 0 || this.targets.size > 0) {
				this.persist();
			}
		}

		context.subscriptions.push(
			this.onDidChangeFileEmitter,
			vscode.workspace.registerFileSystemProvider(SB4_VIRTUAL_SCHEME, this, {
				isCaseSensitive: true,
				isReadonly: false
			})
		);

		this.scheduleAutoRestore(context);
	}

	private cacheFilePath(): string | undefined {
		return this.context ? path.join(this.context.globalStorageUri.fsPath, VirtualDocumentProvider.CACHE_FILE) : undefined;
	}

	private loadFromDisk(): { contents: Record<string, string>; targets: Record<string, string> } | undefined {
		const file = this.cacheFilePath();
		if (!file) {
			return undefined;
		}
		try {
			const raw = fs.readFileSync(file, 'utf-8');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				return {
					contents: typeof parsed.contents === 'object' && parsed.contents ? parsed.contents : {},
					targets: typeof parsed.targets === 'object' && parsed.targets ? parsed.targets : {}
				};
			}
		} catch {
			// Sin caché en disco (primera vez) o corrupto: empezar de cero.
		}
		return undefined;
	}

	/** Escribe el caché completo a disco con debounce (250 ms) y en silencio. */
	private persist() {
		if (!this.context) {
			return;
		}
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			const file = this.cacheFilePath();
			if (!file) {
				return;
			}
			void (async () => {
				try {
					await fsp.mkdir(path.dirname(file), { recursive: true });
					await fsp.writeFile(file, JSON.stringify({
						contents: Object.fromEntries(this.contents),
						targets: Object.fromEntries(this.targets)
					}), 'utf-8');
				} catch {
					// Un fallo de escritura no debe romper la compilación.
				}
			})();
		}, 250);
	}

	public setContent(uri: vscode.Uri, content: string) {
		this.contents.set(uri.toString(), content);
		this.persist();
		this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	/** Asocia el destino de compilación a una pestaña virtual (F6 sin diálogo). */
	public setTarget(uri: vscode.Uri, outputPath: string) {
		this.targets.set(uri.toString(), outputPath);
		this.persist();
	}

	public getTarget(uri: vscode.Uri): string | undefined {
		return this.targets.get(uri.toString());
	}

	/** URIs de las pestañas virtuales persistidas (con contenido o destino). */
	public persistedUris(): vscode.Uri[] {
		const keys = new Set([...this.contents.keys(), ...this.targets.keys()]);
		return [...keys].map((key) => vscode.Uri.parse(key));
	}

	/**
	 * Restauración garantizada: VS Code solo reabre la tab `sb4-tab` si la
	 * conserva en su historia del workbench; este pase reabre desde el caché
	 * cualquier virtual persistida que no haya aparecido, reaplica idioma
	 * sannybuilder + coloreo y no roba foco.
	 *
	 * IMPORTANTE (crash): solo toca pestañas que NO están abiertas. Las que
	 * el workbench ya restauró se DEJAN como están: aplicarles aquí
	 * `setTextDocumentLanguage` mientras el workbench restaura/pinta la sesión
	 * crasheó el extension host (SIGABRT, code 134). Idempotente y con cada
	 * tab en try/catch (una irrecuperable no rompe las demás).
	 */
	public async restoreOpenTabs(): Promise<void> {
		const open = new Set(vscode.workspace.textDocuments.map((doc) => doc.uri.toString()));
		for (const uri of this.persistedUris()) {
			const key = uri.toString();
			if (open.has(key)) {
				continue;
			}
			try {
				const document = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
				void vscode.languages.setTextDocumentLanguage(document, 'sannybuilder').then(() => {
					try {
						const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
						if (editor) {
							SyntaxColoringProvider.getInstance().applyToEditor(editor);
						}
					} catch {
						// Nunca dejar que un fallo de coloreo se propague fuera.
					}
				}, () => { });
			} catch {
				// Una tab irrecuperable no debe romper la restauración de las demás.
			}
		}
	}

	private scheduleAutoRestore(context: vscode.ExtensionContext) {
		// IMPORTANTE (crash): NO correr el restore en los primeros ms del
		// arranque. A los ~200 ms el workbench todavía está restaurando su
		// sesión de editores, y abrir/tocar la tab virtual en ese momento
		// crasheó el extension host (SIGABRT, code 134). El pase corre tras
		// asentarse la restauración (~1 s), y las tabs que reabre son las que
		// YA no estaban en la sesión, así que nunca compite con el workbench.
		let restored = false;
		const run = () => {
			if (restored || !vscode.window.state.focused) {
				return;
			}
			restored = true;
			void this.restoreOpenTabs();
		};
		if (vscode.window.state.focused) {
			setTimeout(run, 1000);
		}
		const sub = vscode.window.onDidChangeWindowState((state) => {
			if (restored || !state.focused) {
				return;
			}
			setTimeout(run, 800);
		});
		context.subscriptions.push(sub);
	}

	// --- vscode.FileSystemProvider: esquema editable en memoria ---

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const content = this.contents.get(uri.toString());
		// Tolerante: durante la restauración de sesión no hay error por ausencia;
		// se sirve un archivo vacío para que VS Code no falle al resolver la tab.
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: content === undefined ? 0 : Buffer.byteLength(content, 'utf-8')
		};
	}

	public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const content = this.contents.get(uri.toString());
		return Buffer.from(content === undefined ? '' : content, 'utf-8');
	}

	public async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
		this.contents.set(uri.toString(), Buffer.from(content).toString('utf-8'));
		this.persist();
		this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	public async readDirectory(_uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		return [];
	}

	public createDirectory(_uri: vscode.Uri): void | Thenable<void> {
		throw vscode.FileSystemError.NoPermissions('Not supported');
	}

	public delete(_uri: vscode.Uri): void | Thenable<void> {
		throw vscode.FileSystemError.NoPermissions('Not supported');
	}

	public rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): void | Thenable<void> {
		throw vscode.FileSystemError.NoPermissions('Not supported');
	}

	public watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}
}