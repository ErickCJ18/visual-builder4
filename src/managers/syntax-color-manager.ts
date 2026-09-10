import { Singleton, StorageKey } from '@utils';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pickRgbColor } from '../components/rgb-color-picker';
import { StorageDataManager } from './storage-data-manager';

export interface SyntaxColorStyle {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
}

const DEFAULT_STYLES: Record<string, SyntaxColorStyle> = {
	comments: { color: '#6A9955' },
	labels: { color: '#DBDCAC' },
	variables: { color: '#98CFE6' },
	keywords: { color: '#AB76A6' },
	numbers: { color: '#B8D7A3' },
	strings: { color: '#BF815D' },
	models: { color: '#B8D7A3' },
	classes: { color: '#4AAE98' },
	commands: { color: '#DBDCAC' },
	directives: { color: '#FFFF00' },
	constants: { color: '#DBDCAC' },
	enums: { color: '#B8D7A3' }
};

const BOOLEAN_TRUE = new Set(['1', 'true', 'yes', 'on']);

/**
 * Convierte el valor de color de un .ini estilo krauber.ini a un hex #RRGGBB.
 * Soporta dos formatos:
 *  - Entero: 0xRRGGBB tal como lo usa Sanny Builder 4 (ej: 12632256 -> #C0C0C0).
 *  - Hex literal: "#C0C0C0".
 */
export function parseColorValue(value: string): string | undefined {
	const trimmed = value.trim();

	if (trimmed.startsWith('#')) {
		return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : undefined;
	}

	const int = Number(trimmed);
	if (Number.isNaN(int)) {
		return undefined;
	}

	const r = (int >> 16) & 0xFF;
	const g = (int >> 8) & 0xFF;
	const b = int & 0xFF;

	const toHex2 = (n: number) => n.toString(16).padStart(2, '0');
	return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/**
 * Lee los colores de sintaxis desde un archivo .ini con el formato de
 * krauber.ini (sección [syntax]) y los expone por categoría. El color de
 * cada categoría es configurable por el usuario: basta con apuntar
 * sb4.colors.iniPath a su archivo (o dejar que se auto-detecte
 * <carpeta SB4>/krauber.ini).
 */
export class SyntaxColorManager extends Singleton {
	private storageDataManager: StorageDataManager = StorageDataManager.getInstance();
	private scheme = new Map<string, SyntaxColorStyle>();
	private iniPath?: string;
	private watcher?: vscode.FileSystemWatcher;
	private onChange?: () => void;
	private extensionPath = '';

	public init(context: vscode.ExtensionContext, onChange?: () => void) {
		this.extensionPath = context.extensionUri.fsPath;
		this.onChange = onChange;
	}

	public async reload() {
		const iniPath = await this.findExistingFile(this.resolveCandidates());

		this.scheme.clear();
		if (iniPath) {
			try {
				const content = await fsp.readFile(iniPath, 'utf-8');
				this.parse(content);
			} catch {
				// Si el archivo no se puede leer, se quedan los valores por defecto.
			}
		}

		this.iniPath = iniPath;
		this.watch(iniPath);
	}

	public getStyle(category: string): SyntaxColorStyle {
		return {
			...(DEFAULT_STYLES[category] ?? {}),
			...(this.scheme.get(category) ?? {})
		};
	}

	public getIniPath(): string | undefined {
		return this.iniPath;
	}

	public getCategories(): string[] {
		return Object.keys(DEFAULT_STYLES);
	}

	// ------------------------------------------------------------------
	// Personalización por comando (SB4: Customize Syntax Colors)
	// ------------------------------------------------------------------

	public async customizeColors(): Promise<void> {
		const categories = this.getCategories();

		const items = categories.map(category => ({
			label: category.replace(/^./, c => c.toUpperCase()),
			description: this.getStyle(category).color,
			category
		}));

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Choose the syntax category to customize'
		});

		if (!picked) {
			return;
		}

		const current = this.getStyle(picked.category).color;
		const hex = await pickRgbColor(`Color for "${picked.label}"`, current);

		if (hex === undefined || hex === current) {
			return;
		}

		const color = this.normalizeHex(hex);
		if (!color) {
			return;
		}

		const iniPath = await this.ensureEditableIniPath();
		if (!iniPath) {
			await vscode.window.showErrorMessage('Select an SB4 folder first (SB4: Select SB4 Folder) to store your custom colors.');
			return;
		}

		await this.ensureFileExists(iniPath);
		await this.writeCategoryColor(iniPath, picked.category, color);

		if (this.getIniPath() !== iniPath) {
			await this.configureIniPath(iniPath);
		}

		await this.reload();
		await vscode.window.showInformationMessage(`Syntax color for "${picked.label}" updated.`);
	}

	/**
	 * Si el archivo objetivo no existe, se crea partiendo del INI activo
	 * (krauber.ini o el ejemplo incluido) para no perder los colores ya
	 * configurados en las categorías que no se tocan.
	 */
	private async ensureFileExists(iniPath: string) {
		try {
			await fsp.access(iniPath);
			return;
		} catch {
			// No existe: se copia el esquema activo.
		}

		const current = this.getIniPath();
		if (current && current !== iniPath) {
			try {
				await fsp.copyFile(current, iniPath);
				return;
			} catch {
				// Fallback al esqueleto.
			}
		}

		await fsp.writeFile(iniPath, [
			'; SB4 - Colores de sintaxis personalizados',
			'; Generado por "SB4: Customize Syntax Colors". Editalo a mano si quieres.',
			'[syntax]'
		].join('\n'), 'utf-8');
	}

	private normalizeHex(value: string): string | undefined {
		const trimmed = value.trim();
		let hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;

		if (/^[0-9a-fA-F]{3}$/.test(hex)) {
			hex = hex.split('').map(c => c.repeat(2)).join('');
		}

		if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
			return undefined;
		}

		return `#${hex.toLowerCase()}`;
	}

	private async ensureEditableIniPath(): Promise<string | undefined> {
		const configured = vscode.workspace.getConfiguration('sb4').get<string>('colors.iniPath')?.trim();
		if (configured) {
			return configured;
		}

		const folderPath = this.storageDataManager.get<string>(StorageKey.Sb4FolderPath);
		if (!folderPath) {
			return undefined;
		}

		return path.join(folderPath, 'sb4-colors.ini');
	}

	private async configureIniPath(iniPath: string) {
		await vscode.workspace.getConfiguration('sb4').update('colors.iniPath', iniPath, vscode.ConfigurationTarget.Global);
	}

	private async writeCategoryColor(iniPath: string, category: string, color: string) {
		let content = '';

		try {
			content = await fsp.readFile(iniPath, 'utf-8');
		} catch {
			content = [
				'; SB4 - Colores de sintaxis personalizados',
				'; Generado por "SB4: Customize Syntax Colors". Editalo a mano si quieres.',
				'[syntax]'
			].join('\n');
		}

		const lines = content.split(/\r?\n/);
		let syntaxStart = -1;
		let syntaxEnd = lines.length;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();

			if (!/^\[[^\]]*\]$/.test(trimmed)) {
				continue;
			}

			if (trimmed.toLowerCase() === '[syntax]') {
				if (syntaxStart === -1) {
					syntaxStart = i;
				}
				continue;
			}

			if (syntaxStart !== -1) {
				syntaxEnd = i;
				break;
			}
		}

		const key = `${category}.color`;
		let replaced = false;

		for (let i = Math.max(syntaxStart, 0); i < syntaxEnd; i++) {
			const eq = lines[i].indexOf('=');
			if (eq > 0 && lines[i].slice(0, eq).trim().toLowerCase() === key) {
				lines[i] = `${key}=${color}`;
				replaced = true;
				break;
			}
		}

		if (!replaced) {
			if (syntaxStart === -1) {
				lines.push('', '[syntax]', `${key}=${color}`);
			} else {
				lines.splice(syntaxEnd, 0, `${key}=${color}`);
			}
		}

		await fsp.writeFile(iniPath, lines.join('\n') + '\n', 'utf-8');
	}

	private resolveCandidates(): string[] {
		const configured = vscode.workspace.getConfiguration('sb4').get<string>('colors.iniPath')?.trim();
		const folderPath = this.storageDataManager.get<string>(StorageKey.Sb4FolderPath);

		const candidates: string[] = [];
		if (configured) {
			candidates.push(configured);
		}
		if (folderPath) {
			candidates.push(path.join(folderPath, 'krauber.ini'));
		}
		candidates.push(path.join(this.extensionPath, 'syntax', 'sb-colors.ini'));

		return candidates;
	}

	private async findExistingFile(candidates: string[]): Promise<string | undefined> {
		for (const candidate of candidates) {
			try {
				if ((await fsp.stat(candidate)).isFile()) {
					return candidate;
				}
			} catch {
				// No existe.
			}
		}

		return undefined;
	}

	private parse(content: string) {
		let section = '';

		for (const raw of content.split(/\r?\n/)) {
			const line = raw.trim();

			if (!line || line.startsWith(';')) {
				continue;
			}

			if (line.startsWith('[') && line.endsWith(']')) {
				section = line.slice(1, -1).trim().toLowerCase();
				continue;
			}

			if (section !== 'syntax') {
				continue;
			}

			const eq = line.indexOf('=');
			if (eq < 0) {
				continue;
			}

			const key = line.slice(0, eq).trim().toLowerCase();
			const value = line.slice(eq + 1).trim();

			const dot = key.indexOf('.');
			if (dot < 0) {
				continue;
			}

			const category = key.slice(0, dot);
			const prop = key.slice(dot + 1);

			let style = this.scheme.get(category);
			if (!style) {
				style = {};
				this.scheme.set(category, style);
			}

			if (prop === 'color') {
				style.color = parseColorValue(value);
			} else if (prop === 'style.bold') {
				style.bold = BOOLEAN_TRUE.has(value.toLowerCase());
			} else if (prop === 'style.italic') {
				style.italic = BOOLEAN_TRUE.has(value.toLowerCase());
			} else if (prop === 'style.underline') {
				style.underline = BOOLEAN_TRUE.has(value.toLowerCase());
			}
		}
	}

	private watch(filePath?: string) {
		this.watcher?.dispose();
		this.watcher = undefined;

		if (!filePath || !this.onChange) {
			return;
		}

		const directory = path.dirname(filePath);
		const basename = path.basename(filePath);

		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(directory, basename),
			true,
			false,
			true
		);

		this.watcher.onDidChange(() => this.onChange?.());
	}
}