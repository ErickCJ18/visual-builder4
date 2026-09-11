import { Singleton } from '@utils';
import * as vscode from 'vscode';

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
	private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	/** Clave en `globalState` para persistir las pestañas virtuales entre sesiones. */
	private static readonly STATE_KEY = 'sb4Tab.virtualDocs';

	private context: vscode.ExtensionContext | undefined;

	public readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

	public init(context: vscode.ExtensionContext) {
		this.context = context;

		// Hidratar con el contenido guardado en la sesión previa: así, al
		// recargar el dev host, la restauración de la tab virtual resuelve su
		// contenido real (en lugar de encontrarla "no encontrada").
		const state = context.globalState.get<Record<string, string>>(VirtualDocumentProvider.STATE_KEY);
		if (state && typeof state === 'object') {
			for (const [uri, content] of Object.entries(state)) {
				if (typeof content === 'string') {
					this.contents.set(uri, content);
				}
			}
		}

		context.subscriptions.push(
			this.onDidChangeFileEmitter,
			vscode.workspace.registerFileSystemProvider(SB4_VIRTUAL_SCHEME, this, {
				isCaseSensitive: true,
				isReadonly: false
			})
		);
	}

	private persist() {
		if (!this.context) {
			return;
		}
		const state: Record<string, string> = {};
		for (const [uri, content] of this.contents) {
			state[uri] = content;
		}
		void this.context.globalState.update(VirtualDocumentProvider.STATE_KEY, state);
	}

	public setContent(uri: vscode.Uri, content: string) {
		this.contents.set(uri.toString(), content);
		this.persist();
		this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
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