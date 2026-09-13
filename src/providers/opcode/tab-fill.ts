import { Singleton } from '@utils';
import * as vscode from 'vscode';
import { BaseProvider } from '../base';

/**
 * "TAB por parámetros": cuando el cursor está en CUALQUIER parte de una línea
 * de opcode expandido (`{02AB:} set_char_proofs {self} [Char] {bulletProof}
 * [bool] ...`), TAB selecciona la casilla `[...]` a reemplazar. Rellenar no
 * "salta" la siguiente: se elige la PRIMERA casilla que arranca en/a partir
 * del cursor (sin estado recordado, así el TAB rápido funciona siempre).
 *
 * - Los marcadores `{nombre}` (llaves) son pistas de SIGNIFICADO y NO se
 *   seleccionan; solo las casillas `[tipo]` (corchetes) son reemplazables.
 * - Seleccionar la casilla completa (incluido `[` y `]`) hace que tipear la
 *   reemplace entera: `[Char]` → `$PLAYER_ACTOR`.
 * - En una línea sin opcode, o con el cursor pasada la última casilla, TAB
 *   conserva el comportamiento por defecto (indentación). La keybinding solo
 *   intercepta con `sb4OpcodeParamContext` true, actualizado con cada
 *   cambio de cursor/editor/texto (con guarda de valor para no spamear).
 */
export class OpcodeTabFillProvider extends Singleton {
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	private static readonly OPCODE_LINE_RE = /\{[0-9a-fA-F]{2,4}:\}/;
	private static readonly SLOT_RE = /\[[^\[\]\r\n]*\]/g;

	// Valor actual del contexto (para no re-setear en cada movimiento de
	// cursor: `setContext` es una ida y vuelta al host, evitarla acelera).
	private context = false;

	public register() {
		const subscriptions = this.baseProvider.context.subscriptions;

		subscriptions.push(
			vscode.commands.registerCommand('sb4.tabFillOpcodeParam', () => this.fillNext())
		);

		subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection(() => this.updateContext()),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
			// La escritura (rellenar un dato) también refresca el contexto al
			// toque: corre antes que la selección en algunos flujos.
			vscode.workspace.onDidChangeTextDocument(event => {
				const editor = vscode.window.activeTextEditor;
				if (editor && event.document === editor.document) {
					this.updateContext();
				}
			})
		);
	}

	/**
	 * Casillas `[tipo]` (corchetes) de la línea, solo si es un opcode
	 * expandido (`{XX:}` presente).
	 */
	private getSlots(textLine: vscode.TextLine): { start: number; end: number }[] {
		const text = textLine.text;
		if (!OpcodeTabFillProvider.OPCODE_LINE_RE.test(text)) {
			return [];
		}

		const slots: { start: number; end: number }[] = [];
		for (const match of text.matchAll(OpcodeTabFillProvider.SLOT_RE)) {
			const start = match.index!;
			slots.push({ start, end: start + match[0].length });
		}
		return slots;
	}

	private async fillNext() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}

		const cursor = editor.selection.active;
		const textLine = editor.document.lineAt(cursor.line);
		const slots = this.getSlots(textLine);

		if (slots.length === 0) {
			// Sin casillas (línea ya rellenada o sin opcode): TAB normal.
			await this.insertFallbackTab(editor);
			return;
		}

		// La casilla "siguiente" se decide por el CURSOR, no por un índice
		// recordado (que al rellenar se corrompía y "se saltaba" una casilla):
		// 1. cursor DENTRO de una casilla → esa casilla (clic en medio de
		//    `[int]` o cursor justo sobre el `[`);
		// 2. si no, la primera casilla que arranca en/a partir del cursor
		//    (la acabo de rellenar → ES la siguiente);
		// 3. cursor tras la última → la primera (ciclo).
		const inside = slots.find(s => s.start <= cursor.character && cursor.character < s.end);
		const after = inside ?? slots.find(s => s.start >= cursor.character) ?? slots[0];

		const range = new vscode.Range(cursor.line, after.start, cursor.line, after.end);
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.Default);
		this.log(`tabFillOpcodeParam: [${textLine.text.slice(after.start, after.end)}] línea ${cursor.line + 1}`);
	}

	/**
	 * Fallback de TAB (línea sin casillas): conserva el comportamiento por
	 * defecto — con selección, indenta las líneas; sin selección inserta una
	 * indentación según la configuración del editor (espacios o tab real).
	 */
	private async insertFallbackTab(editor: vscode.TextEditor) {
		if (!editor.selection.isEmpty) {
			await vscode.commands.executeCommand('editor.action.indentLines');
			return;
		}
		const insertSpaces = editor.options.insertSpaces !== false;
		const tabSize = Number(editor.options.tabSize) || 4;
		const text = insertSpaces ? ' '.repeat(tabSize) : '\t';
		await editor.edit(edit => edit.insert(editor.selection.active, text));
	}

	/**
	 * Refresca `sb4OpcodeParamContext` (gate de la keybinding de TAB) SIEMPRE
	 * que cambia de valor. Al rellenar una línea el contexto ya estaba true y
	 * no vuelve a setearse: cero latencia durante el llenado.
	 */
	private async updateContext() {
		const editor = vscode.window.activeTextEditor;
		const candidate = !!editor
			&& editor.document.languageId === 'sannybuilder'
			&& this.getSlots(editor.document.lineAt(editor.selection.active.line)).length > 0;

		if (candidate !== this.context) {
			this.context = candidate;
			await vscode.commands.executeCommand('setContext', 'sb4OpcodeParamContext', candidate);
		}
	}

	private log(message: string) {
		if (!this.outputChannel) {
			this.outputChannel = vscode.window.createOutputChannel('VB4 Opcode');
		}
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	private outputChannel?: vscode.OutputChannel;
}