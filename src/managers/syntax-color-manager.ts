import { Singleton, StorageKey, showInfoToast } from '@utils';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocaleManager } from '@i18n';
import { pickRgbColor } from '../components/rgb-color-picker';
import { StorageDataManager } from './storage-data-manager';

export interface SyntaxColorStyle {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
}

const DEFAULT_STYLES: Record<string, SyntaxColorStyle> = {
	comments: { color: '#6A9955' },
	labels: { color: '#DBDCAC' },
	variables: { color: '#98CFE6' },
	keywords: { color: '#AB76A6' },
	keywordsIf: { color: '#E06C75' },
	keywordsSwitch: { color: '#D7BA7D' },
	keywordsLoop: { color: '#C586C0' },
	keywordsBoolean: { color: '#569CD6' },
	numbers: { color: '#B8D7A3' },
	strings: { color: '#BF815D' },
	models: { color: '#B8D7A3' },
	classes: { color: '#4AAE98' },
	commands: { color: '#DBDCAC' },
	directives: { color: '#FFFF00' },
	constants: { color: '#DBDCAC' },
	enums: { color: '#B8D7A3' },
	plainText: { color: '#B5B5B5' },
	symbols: { color: '#CC7832' }
};

export function categoryDisplayName(category: string): string {
	return category.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

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

	// Color.ToArgb() devuelve 0xAARRGGBB que puede exceder 0x7FFFFFFF
	// (alfA alta) y caer en negativos como entero con signo de 32 bits;
	// los desplazamientos sin signo (>>>) extraen los bytes RGB sin signo.
	const r = (int >>> 16) & 0xFF;
	const g = (int >>> 8) & 0xFF;
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
	private watchers: vscode.FileSystemWatcher[] = [];
	private reloading = false;
	private onChange?: () => void;
	private extensionPath = '';
	private t = (key: string, params?: Record<string, string>) => LocaleManager.getInstance().t(key, params);

	public init(context: vscode.ExtensionContext, onChange?: () => void) {
		this.extensionPath = context.extensionUri.fsPath;
		this.onChange = onChange;
	}

	public async reload() {
		// Guarda contra recursión: el onChange dispara provider.reload() que
		// vuelve a llamar a este reload().
		if (this.reloading) {
			return;
		}
		this.reloading = true;

		try {
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

			// Refresco inmediato: se repintan al momento las decorations de
			// los editores visibles (sin depender de watchers ni debounce).
			this.onChange?.();
		} finally {
			this.reloading = false;
		}
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

	/**
	 * Devuelve el estilo completo (defaults + lo leído del .ini) de todas las
	 * categorías, para el creador de temas.
	 */
	public getAllStyles(): Record<string, SyntaxColorStyle> {
		const all: Record<string, SyntaxColorStyle> = {};
		for (const category of this.getCategories()) {
			all[category] = this.getStyle(category);
		}
		return all;
	}

	/**
	 * Devuelve el estilo por defecto de la extensión para una categoría (lo
	 * que se usa para el botón "restablecer" del creador de temas).
	 */
	public getDefaultStyle(category: string): SyntaxColorStyle {
		return { ...(DEFAULT_STYLES[category] ?? {}) };
	}

	/**
	 * Aplica un tema completo (todas las categorías) escribiendo el .ini en
	 * uso y refrescando de inmediato. Devuelve true si salió bien.
	 */
	public async applyTheme(styles: Record<string, SyntaxColorStyle>): Promise<boolean> {
		const iniPath = await this.ensureEditableIniPath();
		if (!iniPath) {
			await vscode.window.showErrorMessage(this.t('colors.selectFolderTheme'));
			return false;
		}

		await fsp.writeFile(iniPath, this.buildThemeContent(styles), 'utf-8');

		if (this.getIniPath() !== iniPath) {
			await this.configureIniPath(iniPath);
		}

		await this.reload();
		return true;
	}

	/**
	 * Guarda el tema actual como un archivo nuevo (tema independiente) y lo
	 * deja activo. Devuelve true si salió bien.
	 */
	public async saveThemeAs(styles: Record<string, SyntaxColorStyle>, targetPath: string): Promise<boolean> {
		try {
			await fsp.writeFile(targetPath, this.buildThemeContent(styles), 'utf-8');
		} catch {
			await vscode.window.showErrorMessage(this.t('colors.couldNotWriteTheme', { path: targetPath }));
			return false;
		}

		if (this.getIniPath() !== targetPath) {
			await this.configureIniPath(targetPath);
		}

		await this.reload();
		return true;
	}

	/**
	 * Nombre del archivo de tema que está activo ahora mismo (para mostrarlo
	 * en el creador de temas).
	 */
	public getActiveThemeFileName(): string {
		const iniPath = this.getIniPath();
		return iniPath ? path.basename(iniPath) : 'none';
	}

	private buildThemeContent(styles: Record<string, SyntaxColorStyle>): string {
		const lines: string[] = [
			'; VB4 Theme Creator - colores de sintaxis personalizados',
			'; Generado por "VB4: Theme Creator". Editalo a mano si quieres.',
			'[syntax]'
		];

		for (const category of this.getCategories()) {
			const style = styles[category] ?? {};
			const color = this.normalizeHex(style.color ?? '');
			if (color) {
				lines.push(`${category}.color=${color}`);
			}
			for (const prop of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
				lines.push(`${category}.style.${prop}=${style[prop] ? 1 : 0}`);
			}
		}

		return lines.join('\n') + '\n';
	}

	// ------------------------------------------------------------------
	// Personalización por comando (SB4: Customize Syntax Colors)
	// ------------------------------------------------------------------

	public async customizeColors(): Promise<void> {
		const categories = this.getCategories();

		const items = categories.map(category => ({
			label: categoryDisplayName(category),
			description: this.getStyle(category).color,
			category
		}));

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: this.t('colors.chooseCategory')
		});

		if (!picked) {
			return;
		}

		const current = this.getStyle(picked.category).color;
		const hex = await pickRgbColor(this.t('colors.colorFor', { category: picked.label }), current);

		if (hex === undefined || hex === current) {
			return;
		}

		const color = this.normalizeHex(hex);
		if (!color) {
			return;
		}

		const iniPath = await this.ensureEditableIniPath();
		if (!iniPath) {
			await vscode.window.showErrorMessage(this.t('colors.selectFolderColors'));
			return;
		}

		await this.ensureFileExists(iniPath);
		await this.writeCategoryColor(iniPath, picked.category, color);

		if (this.getIniPath() !== iniPath) {
			await this.configureIniPath(iniPath);
		}

		await this.reload();
		await showInfoToast(this.t('colors.updatedColor', { label: picked.label }));
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
		await this.writeCategoryProp(iniPath, category, 'color', color);
	}

	private async writeCategoryProp(iniPath: string, category: string, prop: string, value: string) {
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

		const key = `${category}.${prop}`;
		let replaced = false;

		for (let i = Math.max(syntaxStart, 0); i < syntaxEnd; i++) {
			const eq = lines[i].indexOf('=');
			if (eq > 0 && lines[i].slice(0, eq).trim().toLowerCase() === key) {
				lines[i] = `${key}=${value}`;
				replaced = true;
				break;
			}
		}

		if (!replaced) {
			if (syntaxStart === -1) {
				lines.push('', '[syntax]', `${key}=${value}`);
			} else {
				lines.splice(syntaxEnd, 0, `${key}=${value}`);
			}
		}

		await fsp.writeFile(iniPath, lines.join('\n') + '\n', 'utf-8');
	}

	// ------------------------------------------------------------------
	// Personalización por estilo de fuente (SB4: Customize Syntax Colors)
	// ------------------------------------------------------------------

	public async customizeFontStyles(): Promise<void> {
		const categories = this.getCategories();

		const items = categories.map(category => ({
			label: categoryDisplayName(category),
			description: this.describeStyle(this.getStyle(category)),
			category
		}));

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: this.t('colors.chooseCategoryFont')
		});

		if (!picked) {
			return;
		}

		await this.editFontStyle(picked.category);
	}

	private describeStyle(style: SyntaxColorStyle): string {
		const parts: string[] = [];
		if (style.bold) {
			parts.push('bold');
		}
		if (style.italic) {
			parts.push('italic');
		}
		if (style.underline) {
			parts.push('underline');
		}
		if (style.strikethrough) {
			parts.push('strikethrough');
		}
		return parts.length ? parts.join(', ') : 'normal';
	}

	private async editFontStyle(category: string) {
		const iniPath = await this.ensureEditableIniPath();
		if (!iniPath) {
			await vscode.window.showErrorMessage(this.t('colors.selectFolderFonts'));
			return;
		}
		await this.ensureFileExists(iniPath);

		const toggles: Array<{ prop: 'bold' | 'italic' | 'underline' | 'strikethrough'; label: string }> = [
			{ prop: 'bold', label: this.t('colors.fontBold') },
			{ prop: 'italic', label: this.t('colors.fontItalic') },
			{ prop: 'underline', label: this.t('colors.fontUnderline') },
			{ prop: 'strikethrough', label: this.t('colors.fontStrikethrough') }
		];

		while (true) {
			const style = this.getStyle(category);

			const picked = await vscode.window.showQuickPick([
				...toggles.map(toggle => ({
					label: `${style[toggle.prop] ? '$(check)' : '$(circle-outline)'} ${toggle.label}`,
					description: style[toggle.prop] ? this.t('colors.currentlyOn') : this.t('colors.currentlyOff'),
					toggle
				})),
				{ label: this.t('colors.done'), description: this.t('colors.doneDesc'), toggle: undefined }
			], { placeHolder: this.t('colors.flipStylePlaceHolder', { category }) });

			if (!picked || !picked.toggle) {
				break;
			}

			await this.writeCategoryProp(iniPath, category, `style.${picked.toggle.prop}`, String(style[picked.toggle.prop] ? 0 : 1));
			await this.reload();
		}

		await showInfoToast(this.t('colors.updatedFonts', { category }));
	}

	// ------------------------------------------------------------------
	// Adaptador de temas SB4 (.ini → formato de la extensión)
	// ------------------------------------------------------------------

	/**
	 * Importa un tema de Sanny Builder 4 (E:\...\themes\*.ini): resuelve los
	 * colores de la sección [syntax] (decimal, 0x..., #hex y referencias a la
	 * sección [variables]) y los convierte a un .ini con el formato propio de
	 * la extensión (sb4-colors.ini), quedando activo de inmediato.
	 */
	public async importTheme(): Promise<void> {
		// Se lee el .ini elegido, se adapta y se refresca de inmediato. No hay
		// ninguna dependencia con el tema "activo" de SB4 ni con settings.ini.
		const themes = await this.listThemes();

		let filePath: string | undefined;

		if (themes.length > 0) {
			const items: Array<{ label: string; description: string; filePath: string | undefined }> = themes.map(t => ({
				label: t.label,
				description: path.basename(t.filePath),
				filePath: t.filePath
			}));
			items.push({ label: this.t('colors.browse'), description: this.t('colors.browseDetail'), filePath: undefined });

			const pick = await vscode.window.showQuickPick(items, {
				placeHolder: this.t('colors.pickTheme')
			});

			if (!pick) {
				return;
			}
			filePath = pick.filePath;
		}

		if (!filePath) {
			const uri = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				title: this.t('colors.pickThemeTitle'),
				filters: { [this.t('colors.themeFilter')]: ['ini'] }
			});

			if (!uri || uri.length === 0) {
				return;
			}
			filePath = uri[0].fsPath;
		}

		let content: string;
		try {
			content = await fsp.readFile(filePath, 'utf-8');
		} catch (err) {
			await vscode.window.showErrorMessage(this.t('colors.couldNotReadTheme', { path: filePath }));
			return;
		}

		const converted = this.convertTheme(filePath, content);
		if (!converted) {
			await vscode.window.showErrorMessage(this.t('colors.noSyntaxSection'));
			return;
		}

		const iniPath = await this.ensureEditableIniPath();
		if (!iniPath) {
			await vscode.window.showErrorMessage(this.t('colors.selectFolderImport'));
			return;
		}

		await fsp.writeFile(iniPath, converted, 'utf-8');

		if (this.getIniPath() !== iniPath) {
			await this.configureIniPath(iniPath);
		}

		await this.reload();
		await showInfoToast(this.t('colors.themeImported', { name: path.basename(filePath) }));
	}

	/**
	 * Lista los temas disponibles en <SB4>\themes\*.ini con su nombre visual
	 * (sección [meta] name).
	 */
	private async listThemes(): Promise<Array<{ filePath: string; label: string }>> {
		const folderPath = this.storageDataManager.get<string>(StorageKey.Sb4FolderPath);
		if (!folderPath) {
			return [];
		}

		const themesDir = path.join(folderPath, 'themes');
		let files: string[];
		try {
			files = (await fsp.readdir(themesDir)).filter(file => file.toLowerCase().endsWith('.ini'));
		} catch {
			return [];
		}

		const themes: Array<{ filePath: string; label: string }> = [];
		for (const file of files) {
			const filePath = path.join(themesDir, file);
			let display = path.basename(file, '.ini');

			try {
				const metaName = this.themeDisplayName(await fsp.readFile(filePath, 'utf-8'));
				if (metaName) {
					display = metaName;
				}
			} catch {
				// Nombre del archivo como fallback.
			}

			themes.push({ filePath, label: display });
		}

		return themes.sort((a, b) => a.label.localeCompare(b.label));
	}

	/**
	 * Extrae el nombre visual de un tema desde su sección [meta] (si existe).
	 */
	private themeDisplayName(content: string): string | undefined {
		let inMeta = false;
		for (const raw of content.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) {
				continue;
			}
			if (line.startsWith('[') && line.endsWith(']')) {
				inMeta = line.slice(1, -1).trim().toLowerCase() === 'meta';
				continue;
			}
			if (!inMeta) {
				continue;
			}
			const eq = line.indexOf('=');
			if (eq > 0 && line.slice(0, eq).trim().toLowerCase() === 'name') {
				const name = line.slice(eq + 1).trim();
				return name || undefined;
			}
		}
		return undefined;
	}

	/**
	 * Resuelve la prioridad de archivos: configurado por el usuario, tema por
	 * defecto de SB4 (<carpeta>\krauber.ini) y el ejemplo incluido.
	 */
	private convertTheme(filePath: string, content: string): string | undefined {
		const variables = new Map<string, string>();
		const syntax = new Map<string, Map<string, string>>();
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

			const eq = line.indexOf('=');
			if (eq < 0) {
				continue;
			}

			const key = line.slice(0, eq).trim().toLowerCase();
			const value = line.slice(eq + 1).trim();

			if (section === 'variables') {
				variables.set(key, value);
				continue;
			}

			if (section !== 'syntax') {
				continue;
			}

			const dot = key.indexOf('.');
			if (dot < 0) {
				continue;
			}

			const category = key.slice(0, dot);
			const prop = key.slice(dot + 1);

			let props = syntax.get(category);
			if (!props) {
				props = new Map();
				syntax.set(category, props);
			}
			props.set(prop, value);
		}

		if (syntax.size === 0) {
			return undefined;
		}

		const resolve = (rawValue: string, depth = 0): string | undefined => {
			const value = rawValue.trim();
			if (depth > 8) {
				return undefined;
			}

			if (value.startsWith('#') || /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
				return parseColorValue(value);
			}

			return resolve(variables.get(value.toLowerCase()) ?? '', depth + 1);
		};

		const lines: string[] = [
			`; Converted from SB4 theme: ${path.basename(filePath)}`,
			'; Imported by "SB4: Import Theme". Alias + style.* con el formato de la extension.',
			'[syntax]'
		];

		for (const [rawCategory, props] of syntax) {
			const category = this.mapThemeCategory(rawCategory);
			if (!category) {
				continue;
			}

			const color = resolve(props.get('color') ?? '');
			if (color) {
				lines.push(`${category}.color=${color}`);
			}

			for (const styleProp of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
				const raw = props.get(`style.${styleProp}`) ?? props.get(`style.${styleProp === 'strikethrough' ? 'struckout' : styleProp}`);
				if (raw !== undefined) {
					lines.push(`${category}.style.${styleProp}=${BOOLEAN_TRUE.has(raw.toLowerCase()) ? 1 : 0}`);
				}
			}
		}

		return lines.join('\n') + '\n';
	}

	private mapThemeCategory(rawCategory: string): string | undefined {
		const known = this.getCategories();
		if (known.includes(rawCategory)) {
			return rawCategory;
		}

		const aliases: Record<string, string> = {
			text: 'comments',
			globals: 'variables',
			opcodes: 'commands',
			'key words': 'keywords'
		};

		return aliases[rawCategory.toLowerCase()];
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
			} else if (prop === 'style.strikethrough' || prop === 'style.struckout' || prop === 'style.strikeout') {
				style.strikethrough = BOOLEAN_TRUE.has(value.toLowerCase());
			}
		}
	}

	/**
	 * Vigila el .ini en uso: si cambia desde fuera (o se edita a mano), se
	 * re-aplica al instante, sin debounce.
	 */
	private watch(filePath?: string) {
		for (const w of this.watchers) {
			w.dispose();
		}
		this.watchers = [];

		if (!filePath || !this.onChange) {
			return;
		}

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)),
			true,
			false,
			true
		);

		watcher.onDidChange(() => this.onChange?.());
		this.watchers.push(watcher);
	}
}