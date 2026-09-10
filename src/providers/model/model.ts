import { isFileExists, Singleton, StorageKey } from '@utils';
import { XMLParser } from 'fast-xml-parser';
import { accessSync, promises as fsp } from 'fs';
import * as path from 'path';
import { GtaVersionManager, StorageDataManager } from '@managers';
import { ModelCompletionProvider } from './completion';

// Secciones .ide cuyos datos llevan el nombre de modelo en la 2ª columna.
const MODEL_SECTIONS = new Set(['objs', 'tobj', 'hier', 'cars', 'peds', 'weap']);

/**
 * Provee los nombres de modelos disponibles para el modo activo, leídos de los
 * archivos `.ide` del juego (referenciados por mode.xml → `<ide>` → `.dat`).
 *
 * Flujo de resolución (igual que hace SB4):
 *  1. `mode.xml` del modo activo lista los `<ide base="@game:\">@game:\data\X.dat</ide>`.
 *  2. El `@game:` se resuelve al `GamePath` del modo en `<SB4>\data\settings.ini`.
 *  3. Cada `.dat` es una lista de `IDE <ruta>` → archivos `.ide` del juego.
 *  4. Cada `.ide` define los modelos: en secciones objs/tobj/hier/cars/peds/weap
 *     el nombre del modelo es la 2ª columna de cada línea de datos.
 */
export class ModelProvider extends Singleton {
	private storageDataManager: StorageDataManager = StorageDataManager.getInstance();
	private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
	private models = new Set<string>();

	public async init() {
		await this.load();

		ModelCompletionProvider.getInstance().register();
	}

	public async reload() {
		await this.load();
	}

	public getModels(): Set<string> {
		return this.models;
	}

	private async load() {
		this.models.clear();

		const folderPath = this.storageDataManager.get(StorageKey.Sb4FolderPath) as string;
		const identifier = this.gtaVersionManager.getIdentifier();

		if (!folderPath || !identifier) {
			return;
		}

		const gamePath = await this.resolveGamePath(folderPath, identifier);

		if (!gamePath) {
			return;
		}

		const modeXmlPath = path.join(folderPath, 'data', identifier, 'mode.xml');

		if (!await isFileExists(modeXmlPath)) {
			return;
		}

		const xmlContent = await fsp.readFile(modeXmlPath, 'utf-8');

		for (const entry of this.parseModeIdeEntries(xmlContent)) {
			if (entry.base && !entry.base.startsWith('@game')) {
				continue;
			}

			const datPath = this.resolveMacro(entry.file, gamePath);
			const basePath = this.resolveMacro(entry.base, gamePath) || gamePath;

			await this.loadIdeList(datPath, basePath);
		}
	}

	/**
	 * Lee un `.dat` (lista de archivos .ide) y carga cada `.ide` listado con
	 * `IDE <ruta>`. Las rutas se resuelven contra la base del `<ide>`
	 * (normalmente `@game:\` → raíz del juego) y, como fallback, contra la
	 * carpeta del propio `.dat`.
	 */
	private async loadIdeList(datPath: string, basePath: string): Promise<void> {
		if (!await isFileExists(datPath)) {
			return;
		}

		const content = await fsp.readFile(datPath, 'utf-8');
		const datDir = path.dirname(datPath);

		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line[0] === '#' ) {
				continue;
			}

			const match = line.match(/^IDE\s+([^\s]+)/i);
			if (!match) {
				continue;
			}

			const idePath = this.resolveIdePath(match[1], basePath, datDir);
			if (idePath) {
				await this.loadIde(idePath);
			}
		}
	}

	private resolveIdePath(relative: string, basePath: string, datDir: string): string | undefined {
		const normalized = relative.replace(/\\/g, path.sep);

		for (const root of [basePath, datDir]) {
			const candidate = path.isAbsolute(normalized)
				? normalized
				: path.join(root, normalized);

			if (candidate && isFileExistsSync(candidate)) {
				return candidate;
			}
		}

		return undefined;
	}

	private async loadIde(idePath: string): Promise<void> {
		if (!await isFileExists(idePath)) {
			return;
		}

		const content = await fsp.readFile(idePath, 'utf-8');
		this.parseIde(content);
	}

	private parseIde(content: string) {
		let section = '';
		const lowerContent = content.toLowerCase();

		for (const rawLine of lowerContent.split(/\r?\n/)) {
			const line = rawLine.trim();

			if (!line || line[0] === '#') {
				continue;
			}

			if (line === 'end') {
				section = '';
				continue;
			}

			// La sección actual es una línea con una sola palabra (sin comas).
			if (!line.includes(',')) {
				if (/^[a-z0-9_]+$/.test(line)) {
					section = line;
				}
				continue;
			}

			if (!MODEL_SECTIONS.has(section)) {
				continue;
			}

			const columns = line.split(',').map(col => col.trim());
			const modelName = columns[1];

			if (modelName && /^[a-z0-9_]+$/.test(modelName)) {
				this.models.add(modelName.toUpperCase());
			}
		}
	}

	/**
	 * Extrae las entradas `<ide>` del mode.xml. Devuelve { file, base } donde
	 * file es el `.dat` a leer y base la ruta base declarada (p.ej. `@game:\`).
	 */
	private parseModeIdeEntries(xmlContent: string): Array<{ file: string; base: string }> {
		try {
			const parser = new XMLParser({
				ignoreAttributes: false,
				textNodeName: "#text"
			});

			const parseData = parser.parse(xmlContent);
			const ides = parseData.mode?.ide;

			if (!ides) {
				return [];
			}

			const arr = Array.isArray(ides) ? ides : [ides];

			return arr.map((entry: any) => ({
				file: typeof entry === 'object' ? entry["#text"] ?? entry["@_src"] : entry,
				base: typeof entry === 'object' ? entry["@_base"] ?? '' : ''
			})).filter(entry => typeof entry.file === 'string' && entry.file.includes('@game'));
		} catch {
			return [];
		}
	}

	/**
	 * Lee `<SB4>\data\settings.ini` y obtiene el GamePath del modo activo.
	 * Prioridad: sección con el mismo identifier → sección con prefijo común
	 * → primer GamePath que aparezca en el archivo.
	 */
	private async resolveGamePath(folderPath: string, identifier: string): Promise<string | undefined> {
		const settingsPath = path.join(folderPath, 'data', 'settings.ini');

		if (!await isFileExists(settingsPath)) {
			return undefined;
		}

		const content = await fsp.readFile(settingsPath, 'utf-8');
		const sections = this.parseSettingsIni(content);
		const id = identifier.toLowerCase();

		for (const [name, gamePath] of sections) {
			if (name === id) {
				return gamePath;
			}
		}

		for (const [name, gamePath] of sections) {
			if (name.startsWith(id) || id.startsWith(name)) {
				return gamePath;
			}
		}

		return configFallback(content);
	}

	private parseSettingsIni(content: string): Map<string, string> {
		const result = new Map<string, string>();
		let currentSection = '';

		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line[0] === ';') {
				continue;
			}

			const sectionMatch = line.match(/^\[([^\]]+)\]/);
			if (sectionMatch) {
				currentSection = sectionMatch[1].toLowerCase();
				continue;
			}

			const keyMatch = line.match(/^GamePath\s*=\s*(.+)$/i);
			if (keyMatch && currentSection) {
				result.set(currentSection, keyMatch[1].trim());
			}
		}

		return result;
	}

	private resolveMacro(value: string, gamePath: string): string {
		return value.replace(/@game:(\\)?/g, () => `${gamePath}\\`);
	}
}

function configFallback(content: string): string | undefined {
	const match = content.match(/^GamePath\s*=\s*(.+)$/m);
	return match ? match[1].trim() : undefined;
}

function isFileExistsSync(filePath: string): boolean {
	try {
		accessSync(filePath);
		return true;
	} catch {
		return false;
	}
}