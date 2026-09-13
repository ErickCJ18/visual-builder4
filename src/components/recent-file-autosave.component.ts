import { Singleton } from '@utils';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import * as path from 'path';
import * as vscode from 'vscode';
import { SyntaxColoringProvider } from '../providers/syntax/syntax-coloring-provider';

export const SB4_AUTOSAVE_SCHEME = 'sb4-recent';

const AUTOSAVE_FILE = 'sb4-recent-autosave.json';
const AUTOSAVE_LANGUAGES = new Set(['sannybuilder', 'sannybuilder-fxt']);
const SNAPSHOT_DEBOUNCE_MS = 400;
const PERSIST_DEBOUNCE_MS = 500;
const MAX_ALL_ENTRIES = 20;

interface AutosaveEntry {
	fsPath: string;
	content: string;
	updatedAt: number;
}

interface AutosaveSnapshot {
	entries: Record<string, AutosaveEntry>;
}

export class RecentFileAutosave extends Singleton implements vscode.FileSystemProvider {
	private readonly entries = new Map<string, AutosaveEntry>();
	private readonly contents = new Map<string, string>();
	private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	private context: vscode.ExtensionContext | undefined;
	private snapshotTimer: NodeJS.Timeout | undefined;
	private persistTimer: NodeJS.Timeout | undefined;
	private pendingSnapshotUri: vscode.Uri | undefined;

	public readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

	public init(context: vscode.ExtensionContext) {
		this.context = context;

		const disk = this.loadFromDisk();
		if (disk) {
			for (const entry of Object.values(disk.entries)) {
				if (entry && typeof entry.content === 'string' && entry.fsPath) {
					this.entries.set(this.keyOf(entry.fsPath), entry);
					this.contents.set(this.virtualUriFor(entry.fsPath).toString(), entry.content);
				}
			}
		}

		context.subscriptions.push(
			this.onDidChangeFileEmitter,
			vscode.workspace.onDidChangeTextDocument((event) => this.handleChange(event)),
			vscode.workspace.registerFileSystemProvider(SB4_AUTOSAVE_SCHEME, this, {
				isCaseSensitive: true,
				isReadonly: false
			})
		);

		void this.runSweep().then(() => this.scheduleAutoRestore(context));
	}

	/**
	 * Limpieza automática al arrancar: descarta entradas cuyo archivo real ya no
	 * existe en disco, o que superan el límite de edad configurado (0 = sin tope).
	 */
	public async runSweep(): Promise<number> {
		if (!this.isEnabled() || this.entries.size === 0) {
			return 0;
		}
		const ttl = this.getMaxAgeDays() > 0 ? this.getMaxAgeDays() * 86400000 : Number.POSITIVE_INFINITY;
		const now = Date.now();
		let removed = 0;
		for (const [key, entry] of [...this.entries]) {
			const expired = now - entry.updatedAt > ttl;
			let gone = false;
			if (!expired) {
				try {
					await fsp.access(entry.fsPath);
				} catch {
					gone = true;
				}
			}
			if (expired || gone) {
				this.entries.delete(key);
				this.contents.delete(this.virtualUriFor(entry.fsPath).toString());
				removed++;
			}
		}
		if (removed > 0) {
			this.flushPersistNow();
		}
		return removed;
	}

	private isEnabled(): boolean {
		return vscode.workspace.getConfiguration('sb4').get<boolean>('autosave.enabled', true);
	}

	private getMode(): 'recent' | 'all' {
		return vscode.workspace.getConfiguration('sb4').get<'recent' | 'all'>('autosave.mode', 'recent');
	}

	private getMaxAgeDays(): number {
		const days = vscode.workspace.getConfiguration('sb4').get<number>('autosave.maxAgeDays', 7);
		return Number.isFinite(days) && days >= 0 ? Math.floor(days) : 7;
	}

	private keyOf(fsPath: string): string {
		const normalized = path.normalize(fsPath);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}

	private virtualUriFor(realFsPath: string): vscode.Uri {
		const p = '/' + realFsPath.split(/[\\/]+/).join('/');
		return vscode.Uri.parse(`${SB4_AUTOSAVE_SCHEME}:${p}`);
	}

	private realFsPathOf(uri: vscode.Uri): string | undefined {
		const p = uri.path.replace(/^\//, '');
		if (!p) {
			return undefined;
		}
		return process.platform === 'win32' ? p.replace(/\//g, '\\') : '/' + p;
	}

	private handleChange(event: vscode.TextDocumentChangeEvent) {
		if (!this.isEnabled()) {
			return;
		}
		const doc = event.document;
		if (doc.uri.scheme !== 'file' || doc.isUntitled || !AUTOSAVE_LANGUAGES.has(doc.languageId)) {
			return;
		}
		this.pendingSnapshotUri = doc.uri;
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
		}
		this.snapshotTimer = setTimeout(() => this.flushSnapshot(), SNAPSHOT_DEBOUNCE_MS);
	}

	private store(entry: AutosaveEntry) {
		const key = this.keyOf(entry.fsPath);
		const virtualKey = this.virtualUriFor(entry.fsPath).toString();
		if (this.getMode() === 'recent') {
			for (const [k, other] of [...this.entries]) {
				if (k !== key) {
					this.contents.delete(this.virtualUriFor(other.fsPath).toString());
					this.entries.delete(k);
				}
			}
		}
		this.entries.set(key, entry);
		this.contents.set(virtualKey, entry.content);
		if (this.getMode() === 'all' && this.entries.size > MAX_ALL_ENTRIES) {
			const sorted = [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
			for (const old of sorted.slice(MAX_ALL_ENTRIES)) {
				this.entries.delete(this.keyOf(old.fsPath));
				this.contents.delete(this.virtualUriFor(old.fsPath).toString());
			}
		}
	}

	private flushSnapshot() {
		this.snapshotTimer = undefined;
		const uri = this.pendingSnapshotUri;
		this.pendingSnapshotUri = undefined;
		if (!uri || !this.isEnabled()) {
			return;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (!doc) {
			return;
		}
		this.store({ fsPath: uri.fsPath, content: doc.getText(), updatedAt: Date.now() });
		this.schedulePersist();
	}

	private schedulePersist() {
		if (this.persistTimer) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.flushPersistNow();
		}, PERSIST_DEBOUNCE_MS);
	}

	private flushPersistNow() {
		const file = this.cacheFilePath();
		if (!file) {
			return;
		}
		void (async () => {
			try {
				await fsp.mkdir(path.dirname(file), { recursive: true });
				await fsp.writeFile(file, JSON.stringify({ entries: Object.fromEntries(this.entries) } satisfies AutosaveSnapshot), 'utf-8');
			} catch {
			}
		})();
	}

	private cacheFilePath(): string | undefined {
		return this.context ? path.join(this.context.globalStorageUri.fsPath, AUTOSAVE_FILE) : undefined;
	}

	private loadFromDisk(): AutosaveSnapshot | undefined {
		const file = this.cacheFilePath();
		if (!file) {
			return undefined;
		}
		try {
			const raw = fs.readFileSync(file, 'utf-8');
			const parsed = JSON.parse(raw) as AutosaveSnapshot;
			if (parsed && typeof parsed.entries === 'object' && parsed.entries) {
				return parsed;
			}
		} catch {
		}
		return undefined;
	}

	public async clearCache(): Promise<void> {
		this.entries.clear();
		this.contents.clear();
		this.flushPersistNow();
	}

	public getSnapshotInfo(): { count: number; lastFile: string | undefined; lastUpdatedAt: number } {
		let lastFile: string | undefined;
		let lastUpdatedAt = 0;
		for (const entry of this.entries.values()) {
			if (entry.updatedAt > lastUpdatedAt) {
				lastUpdatedAt = entry.updatedAt;
				lastFile = entry.fsPath;
			}
		}
		return { count: this.entries.size, lastFile, lastUpdatedAt };
	}

	public async restoreTabs(): Promise<void> {
		const open = new Set(vscode.workspace.textDocuments.map((doc) => doc.uri.toString()));
		for (const entry of this.entries.values()) {
			const realUri = vscode.Uri.file(entry.fsPath);
			const virtualUri = this.virtualUriFor(entry.fsPath);
			const virtualKey = virtualUri.toString();
			if (open.has(realUri.toString()) || open.has(virtualKey)) {
				continue;
			}
			const onDisk = this.readDiskText(entry.fsPath);
			if (onDisk !== undefined && onDisk === entry.content) {
				continue;
			}
			try {
				const document = await vscode.workspace.openTextDocument(virtualUri);
				await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
				const language = entry.fsPath.toLowerCase().endsWith('.fxt') ? 'sannybuilder-fxt' : 'sannybuilder';
				void vscode.languages.setTextDocumentLanguage(document, language).then(() => {
					try {
						const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === virtualKey);
						if (editor) {
							SyntaxColoringProvider.getInstance().applyToEditor(editor);
						}
					} catch {
					}
				}, () => { });
			} catch {
			}
		}
	}

	private scheduleAutoRestore(context: vscode.ExtensionContext) {
		let restored = false;
		const run = () => {
			if (restored || !vscode.window.state.focused) {
				return;
			}
			restored = true;
			void this.restoreTabs();
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

	private readDiskText(fsPath: string): string | undefined {
		try {
			return iconv.decode(fs.readFileSync(fsPath), 'cp1252');
		} catch {
			return undefined;
		}
	}

	private encodeDiskText(text: string): Buffer {
		const ansi = iconv.encode(text, 'cp1252');
		return iconv.decode(ansi, 'cp1252') === text ? ansi : Buffer.from(text, 'utf-8');
	}

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const content = this.contents.get(uri.toString());
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
		const text = Buffer.from(content).toString('utf-8');
		const realFsPath = this.realFsPathOf(uri);
		this.contents.set(uri.toString(), text);
		if (realFsPath) {
			this.store({ fsPath: realFsPath, content: text, updatedAt: Date.now() });
			try {
				await fsp.mkdir(path.dirname(realFsPath), { recursive: true });
				await fsp.writeFile(realFsPath, this.encodeDiskText(text));
			} catch {
			}
		}
		this.schedulePersist();
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