import { Command, Singleton, showInfoToast } from '@utils';
import * as vscode from 'vscode';
import { CommandManager } from '@managers';
import { LocaleManager } from '@i18n';
import { BaseProvider } from '../base';
import { buildOpcodeLine } from './format';

/**
 * "F1": escribe un NÚMERO de opcode (00A5, 009, 4..) y F1 lo completa con el
 * opcode completo tipado que más se aproxime. Delante del cursor solo se lee
 * un hex de 2 a 4 cifras (los opcodes de SB4 tienen nombres en hex).
 *
 * Sitúa el cursor sobre el código que acaba de autocompletar.
 */
export class OpcodeExpandProvider extends Singleton {
	private commands: CommandManager = CommandManager.getInstance();
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	private t = (key: string, params?: Record<string, string | number>) =>
		LocaleManager.getInstance().t(key, params);

	public register() {
		this.baseProvider.context.subscriptions.push(
			vscode.commands.registerCommand('sb4.expandOpcode', () => this.expand())
		);
	}

	private async expand() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void showInfoToast(this.t('ox.noEditor'));
			return;
		}

		const position = editor.selection.active;
		const lineText = editor.document.lineAt(position.line).text;
		const prefix = lineText.slice(0, position.character);

		// CICLO: si la línea ya contiene un opcode expandido "{XXXX:}" y el
		// cursor está dentro de su texto, F1 NO re-expande ni apila: CAMBIA
		// el id al SIGUIENTE opcode parecido y reescribe toda la línea
		// (0090 → 0091 → 0092 ...). Traba con el cursor en CUALQUIER punto
		// del opcode: tras la llave, dentro del número, entre los
		// argumentos o al final de la línea.
		const braceStart = prefix.lastIndexOf('{');
		const fullOpcodeToken = (braceStart >= 0)
			? /^\{([0-9a-fA-F]{2,4}):\}/.exec(lineText.slice(braceStart))
			: null;

		if (fullOpcodeToken) {
			// El id real del token (aunque el cursor esté a media escritura)
			// se lee desde la LÍNEA completa, no del prefijo.
			await this.cycleOpcode(editor, fullOpcodeToken[1], position, braceStart);
			return;
		}

		// Solo hex delante del cursor (2..4 cifras, con ":" opcional estilo
		// "00A5:"): 4F, 009a, 0A5, 00A5, 00A5: ...
		const match = prefix.match(/([0-9a-fA-F]{2,4})\s*:?$/);
		if (!match) {
			void showInfoToast(this.t('ox.noCode'));
			return;
		}

		// "typed" = el hex tal cual; "replacedStart" cubre hex + ":"/espacios.
		const typed = match[1];
		const replacedStart = position.translate(0, -match[0].length);
		const lower = typed.toLowerCase();

		// Búsqueda "lo más aproximada posible":
		//  1. id EXACTO (00A5 → 00A5);
		//  2. prefijo directo (009 → el 0090..009F más bajo);
		//  3. sin ceros a la izquierda (0A5 → 00A5, 4F → 004F): el hex se
		//     compara "canónico" (el id sin los ceros de relleno: 00A5 → A5);
		//  4. prefijo canónico (13 → 0130...).
		// Los pasos 3/4 solo entran si el prefijo directo no dio resultados,
		// así tipear "2" sigue eligiendo 2000 (prefijo) y no 0002.
		const all = [...this.commands.getCommands().values()];
		const lowercased = (s: string) => s.toLowerCase();
		const canonical = (s: string) => s.replace(/^0+/, '') || '0';

		const byId = (a: Command, b: Command) => (a.id ?? '').localeCompare(b.id ?? '');

		const exact = all.find(c => c.id && lowercased(c.id) === lower);
		const byPrefix = exact ? [exact] :
			all.filter(c => c.id && lowercased(c.id).startsWith(lower)).sort(byId);
		const byCanon = byPrefix.length ? byPrefix : all.filter(c => {
			if (!c.id) {
				return false;
			}
			const canonId = canonical(lowercased(c.id));
			const canonTyped = canonical(lower);
			return canonId === canonTyped || canonId.startsWith(canonTyped);
		}).sort(byId);

		const chosen = exact ?? byPrefix[0] ?? byCanon[0];
		if (!chosen) {
			void showInfoToast(this.t('ox.notFound', { code: typed }));
			return;
		}

		await this.insertOpcode(editor, replacedStart, position, chosen);
	}

	/**
	 * F1 repetido sobre un opcode ya expandido `{XXXX:}`: cambia SÓLO el id
	 * dentro de las llaves al SIGUIENTE opcode "parecido" (ciclando por la
	 * familia de IDs) y deja el cursor tras la llave. El resto de la línea
	 * (los argumentos ya escritos) se conserva.
	 */
	private async cycleOpcode(
		editor: vscode.TextEditor,
		address: string,
		position: vscode.Position,
		braceStart: number
	) {
		const lower = address.toLowerCase();
		const all = [...this.commands.getCommands().values()];
		const byId = (a: Command, b: Command) => (a.id ?? '').localeCompare(b.id ?? '');
		const sorted = all.sort(byId);

		// Familia "parecida": el prefijo más corto (2..4 hex) del id actual
		// que todavía contenga "vecinos" (≥2 opcodes). Típicamente los dos
		// primeros dígitos: 0090 → 0090..009F.
		let family = sorted.filter(c => c.id && c.id.toLowerCase().startsWith(lower));
		if (family.length < 2) {
			for (let len = 2; len <= 4 && family.length < 2; len++) {
				const p = lower.slice(0, len);
				family = sorted.filter(c => c.id && c.id.toLowerCase().startsWith(p));
			}
		}

		if (family.length < 2) {
			void showInfoToast(this.t('ox.notFound', { code: address }));
			return;
		}

		const i = family.findIndex(c => c.id!.toLowerCase() === lower);
		const next = family[(i + 1) % family.length];
		if (!next.id) {
			return;
		}

		// Reconstruye TODA la línea (desde la llave hasta el final) con el
		// nuevo opcode: "{0091:} cset_var_float_to_lvar_int [float] [int]".
		// "braceStart" marca la llave hallada en el prefijo.
		const lineIndex = position.line;
		const lineText = editor.document.lineAt(lineIndex).text;
		const nextBrace = `{${next.id}:}`;
		const range = new vscode.Range(
			new vscode.Position(lineIndex, braceStart),
			new vscode.Position(lineIndex, lineText.length)
		);
		await editor.edit(edit => edit.replace(range, buildOpcodeLine(next)));

		// Cursor tras la llave nueva, igual que tras el expand normal.
		const newPos = new vscode.Position(lineIndex, braceStart + nextBrace.length);
		editor.selection = new vscode.Selection(newPos, newPos);

		// Contexto de TAB ya same inline: el listener de selección puede llegar
		// tarde si F1 y TAB se encadenan muy rápido.
		this.armTabContext();
	}

	private async insertOpcode(
		editor: vscode.TextEditor,
		start: vscode.Position,
		end: vscode.Position,
		command: Command
	) {
		const range = new vscode.Range(start, end);

		const line = buildOpcodeLine(command);
		await editor.edit(edit => edit.replace(range, line));

		// Deja el cursor justo tras el "{00A5:}" (el número de opcode ya
		// tipado), listo para seguir con el resto de la línea.
		const brace = `{${command.id}:}`;
		const newLineText = editor.document.lineAt(end.line).text;
		const idx = newLineText.indexOf(brace);
		const newPos = end.with(0, (idx >= 0 ? idx : start.character) + brace.length);
		editor.selection = new vscode.Selection(newPos, newPos);

		// Igual que en cycleOpcode: contexto de TAB ya activo en el mismo
		// tick, sin esperar al evento de selección.
		this.armTabContext();
	}

	/** Activa el gate de la keybinding de TAB sin latencia tras el expand. */
	private armTabContext() {
		void vscode.commands.executeCommand('setContext', 'sb4OpcodeParamContext', true);
	}
}