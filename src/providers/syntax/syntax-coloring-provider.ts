import { CommandManager } from '@managers';
import { CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { Token } from '../../lexer/token';
import { TokenKind } from '../../lexer/token-kind';
import { Tokenizer } from '../../lexer/tokenizer';
import { SyntaxColorManager, SyntaxColorStyle } from '../../managers/syntax-color-manager';
import { BaseProvider } from '../base';
import { ClassProvider } from '../class/class';
import { EnumProvider } from '../enum/enum';

const CATEGORY_COMMENTS = 'comments';
const CATEGORY_LABELS = 'labels';
const CATEGORY_VARIABLES = 'variables';
const CATEGORY_KEYWORDS = 'keywords';
const CATEGORY_KEYWORDS_IF = 'keywordsIf';
const CATEGORY_KEYWORDS_SWITCH = 'keywordsSwitch';
const CATEGORY_KEYWORDS_LOOP = 'keywordsLoop';
const CATEGORY_KEYWORDS_BOOLEAN = 'keywordsBoolean';
const CATEGORY_NUMBERS = 'numbers';
const CATEGORY_STRINGS = 'strings';
const CATEGORY_CLASSES = 'classes';
const CATEGORY_COMMANDS = 'commands';
const CATEGORY_ENUMS = 'enums';
const CATEGORY_MODELS = 'models';
const CATEGORY_DIRECTIVES = 'directives';
const CATEGORY_PLAINTEXT = 'plainText';
const CATEGORY_SYMBOLS = 'symbols';

// Misma lista de palabras clave que usa la gramática (syntax/sb4.tm-language.json).
export const KEYWORDS = new Set([
	'and', 'array', 'as', 'alloc', 'boolean', 'bool', 'break', 'case', 'cdecl', 'class', 'const',
	'continue', 'dec', 'define', 'default', 'div', 'downto', 'else', 'end', 'enum', 'export',
	'false', 'float', 'for', 'from', 'function', 'handle', 'hex', 'if', 'import', 'inc', 'int',
	'integer', 'logical', 'longstring', 'mul', 'not', 'of', 'optional', 'or', 'random', 'readmem',
	'repeat', 'return', 'shortstring', 'string', 'stdcall', 'sqr', 'switch', 'then', 'thiscall',
	'to', 'true', 'unknown', 'until', 'var', 'while', 'writemem'
]);

// Estructuras condicionales / de decisión (if/then/else, switch/case).
export const KEYWORDS_IF = new Set([
	'if', 'then', 'else', 'elsif', 'endif', 'end'
]);

// Estructuras de decisión múltiple.
export const KEYWORDS_SWITCH = new Set([
	'switch', 'case', 'default'
]);

// Bucles y saltos de control (while/for/repeat/until + break/continue/return).
export const KEYWORDS_LOOP = new Set([
	'while', 'for', 'repeat', 'until', 'do', 'downto', 'from', 'to',
	'break', 'continue', 'return'
]);

// Constantes booleanas.
export const KEYWORDS_BOOLEAN = new Set([
	'true', 'false'
]);

// Símbolos de programación (operadores de comparación/asignación/aritméticos).
const symbolRe = /==|!=|>=|<=|[+\-*/<>=]/g;

const DEBOUNCE_MS = 400;

/**
 * Colorea la sintaxis del lenguaje SB usando un esquema de colores definido
 * por el usuario en un archivo .ini (formato krauber.ini, sección [syntax]).
 *
 * A diferencia de la gramática TextMate (que solo colorea keywords y
 * comentarios), aquí se usan "decorations" de VS Code calculadas con el
 * Tokenizer + los datos reales de la librería (opcodes, clases y enums),
 * así cada categoría (keywords, números, strings, clases, comandos, enums,
 * variables, labels, comentarios, directivas...) se pinta con el color que
 * el usuario haya elegido en su .ini.
 */
export class SyntaxColoringProvider extends Singleton {
	private baseProvider: BaseProvider = BaseProvider.getInstance();
	private colorManager: SyntaxColorManager = SyntaxColorManager.getInstance();
	private decorations = new Map<string, vscode.TextEditorDecorationType>();
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private memberNames = new Set<string>();
	private className = new Set<string>();
	private enumNames = new Set<string>();

	public async init() {
		this.colorManager.init(this.baseProvider.context, () => { void this.reload(); });
		await this.colorManager.reload();
		this.buildLookups();
		this.rebuildDecorations();
		this.registerListeners();
		this.applyToVisibleEditors();
	}

	public async reload() {
		await this.colorManager.reload();
		this.buildLookups();
		this.rebuildDecorations();
		this.applyToVisibleEditors();
	}

	private buildLookups() {
		// La categoría "commands" colorea SOLO los métodos de clase (el miembro
		// de "char.IsInAir" / "camera.Shake"), no los nombres sueltos de
		// opcodes (wait, load_scene, create_char) que van sin color.
		this.memberNames.clear();
		for (const command of CommandManager.getInstance().getCommands().values()) {
			if (command.member) {
				this.memberNames.add(command.member.toLowerCase());
			}
		}

		this.className.clear();
		for (const name of ClassProvider.getInstance().get().keys()) {
			this.className.add(name.toLowerCase());
		}

		this.enumNames.clear();
		for (const [enumName, elements] of EnumProvider.getInstance().get()) {
			this.enumNames.add(enumName.toLowerCase());
			for (const element of elements) {
				this.enumNames.add(element.name.toLowerCase());
			}
		}
	}

	private registerListeners() {
		this.baseProvider.context.subscriptions.push(
			vscode.workspace.onDidOpenTextDocument(doc => this.scheduleApply(doc)),
			vscode.workspace.onDidChangeTextDocument(event => this.scheduleApply(event.document)),
			vscode.workspace.onDidCloseTextDocument(doc => this.clearTimer(doc.uri.toString())),
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (this.isSbEditor(editor)) {
					this.applyToEditor(editor);
				}
			}),
			vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(editor => {
				if (this.isSbEditor(editor)) {
					this.applyToEditor(editor);
				}
			})),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('sb4.colors')) {
					void this.reload();
				}
			})
		);
	}

	private isSbEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
		return editor?.document.languageId === CONFIG.LANGUAGE_SELECTOR.language;
	}

	private scheduleApply(document: vscode.TextDocument) {
		if (document.languageId !== CONFIG.LANGUAGE_SELECTOR.language) {
			return;
		}

		const key = document.uri.toString();
		this.clearTimer(key);

		this.debounceTimers.set(key, setTimeout(() => {
			this.debounceTimers.delete(key);

			for (const editor of vscode.window.visibleTextEditors) {
				if (editor.document.uri.toString() === key) {
					this.applyToEditor(editor);
				}
			}
		}, DEBOUNCE_MS));
	}

	private clearTimer(key: string) {
		const existing = this.debounceTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(key);
		}
	}

	private applyToVisibleEditors() {
		vscode.window.visibleTextEditors.forEach(editor => {
			if (this.isSbEditor(editor)) {
				this.applyToEditor(editor);
			}
		});
	}

	private applyToEditor(editor: vscode.TextEditor) {
		const rangesByCategory = this.analyze(editor.document);

		for (const [category, decorationType] of this.decorations) {
			editor.setDecorations(decorationType, rangesByCategory.get(category) ?? []);
		}
	}

	private rebuildDecorations() {
		for (const decorationType of this.decorations.values()) {
			decorationType.dispose();
		}
		this.decorations.clear();

		if (!vscode.workspace.getConfiguration('sb4').get<boolean>('colors.enabled', true)) {
			return;
		}

		for (const category of this.colorManager.getCategories()) {
			this.decorations.set(category, this.createDecoration(this.colorManager.getStyle(category)));
		}
	}

	private createDecoration(style: SyntaxColorStyle): vscode.TextEditorDecorationType {
		const textDecorations: string[] = [];
		if (style.underline) {
			textDecorations.push('underline');
		}
		if (style.strikethrough) {
			textDecorations.push('line-through');
		}

		return vscode.window.createTextEditorDecorationType({
			color: style.color,
			fontWeight: style.bold ? 'bold' : undefined,
			fontStyle: style.italic ? 'italic' : undefined,
			textDecoration: textDecorations.length ? textDecorations.join(' ') : undefined
		});
	}

	// ------------------------------------------------------------------
	// Análisis del documento
	// ------------------------------------------------------------------
private analyze(document: vscode.TextDocument): Map<string, vscode.Range[]> {
		const text = document.getText();
		const byCategory = new Map<string, vscode.Range[]>();
		// Exclusiones como pares [start, end) en offsets de carácter; se
		// barren con UNA sola pasada (puntero) tras ordenarlas.
		const exclusions: { start: number; end: number }[] = [];

		const push = (category: string, range: vscode.Range) => {
			let ranges = byCategory.get(category);
			if (!ranges) {
				ranges = [];
				byCategory.set(category, ranges);
			}
			ranges.push(range);
		};

		const exclude = (startOffset: number, endOffset: number) => {
			exclusions.push({ start: startOffset, end: endOffset });
		};

		const lineStarts = this.buildLineStarts(text);
		const pos = (offset: number) => this.positionAt(lineStarts, offset);
		const range = (startOffset: number, endOffset: number) => new vscode.Range(pos(startOffset), pos(endOffset));

		// Comentarios de línea (//), de bloque (/* ... */) y de llaves ({ ... }).
		// Las directivas {$...} se excluyen de "llaves" a propósito: el patrón
		// de comentario exige que el segundo carácter NO sea '$'.
		const commentRe = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
		const braceCommentRe = /\{[^$][\s\S]*?\}/g;

		for (const match of text.matchAll(commentRe)) {
			const start = match.index ?? 0;
			const r = range(start, start + match[0].length);
			push(CATEGORY_COMMENTS, r);
			// El tokenizer no reconoce los comentarios de bloque (/* */), así
			// que sus tokens sueltos deben excluirse para no pintarlos encima.
			exclude(start, start + match[0].length);
		}

		for (const match of text.matchAll(braceCommentRe)) {
			const start = match.index ?? 0;
			const r = range(start, start + match[0].length);
			push(CATEGORY_COMMENTS, r);
			exclude(start, start + match[0].length);
		}

		// Números hexadecimales (0x...) — categoría números. Se excluyen del
		// pasaje del tokenizer para que no los repinte el dígito suelto "0".
		const hexRe = /\b0x[0-9A-Fa-f]+\b/g;
		for (const match of text.matchAll(hexRe)) {
			const start = match.index ?? 0;
			push(CATEGORY_NUMBERS, range(start, start + match[0].length));
			exclude(start, start + match[0].length);
		}

		// Directivas: {$...}
		const directiveRe = /\{\$[^}\n]*\}/g;
		for (const match of text.matchAll(directiveRe)) {
			const start = match.index ?? 0;
			const r = range(start, start + match[0].length);
			push(CATEGORY_DIRECTIVES, r);
			exclude(start, start + match[0].length);
		}

		// Por línea: dirección de opcode al inicio y declaraciones [var nombre: Tipo]
		// (el nombre puede ser "0@", "$var" o un identificador; "var" en
		// mayúsculas o minúsculas).
		const lines = text.split(/\r?\n/);
		const addressRe = /^(\s*[0-9A-Fa-f]{2,4}\s*:)/;
		const varDeclRe = /\[var\s+([^\s:]+?)\s*:\s*([A-Za-z_]\w*)\]/gi;

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const lineText = lines[lineIndex];
			const lineStart = lineStarts[lineIndex] ?? 0;

			const addressMatch = addressRe.exec(lineText);
			if (addressMatch) {
				// El código numérico del opcode (0005:, 0861:...) es texto base
				// (categoría plainText), NO un comando (solo los métodos de clase
				// como char.IsInAir llevan la categoría commands).
				const r = range(lineStart, lineStart + addressMatch[1].length);
				push(CATEGORY_PLAINTEXT, r);
				exclude(lineStart, lineStart + addressMatch[1].length);
			}

			varDeclRe.lastIndex = 0;
			for (const match of lineText.matchAll(varDeclRe)) {
				const wholeStart = lineStart + (match.index ?? 0);
				const wholeEnd = wholeStart + match[0].length;

				exclude(wholeStart, wholeEnd);

				const nameOffset = wholeStart + match[0].indexOf(match[1]);
				push(CATEGORY_VARIABLES, range(nameOffset, nameOffset + match[1].length));

				const typeOffset = wholeStart + match[0].lastIndexOf(match[2]);
				push(CATEGORY_CLASSES, range(typeOffset, typeOffset + match[2].length));
			}
		}

		exclusions.sort((a, b) => a.start - b.start);

		// Símbolos de programación (==, =, >, <, +, -, *, /...). Se pintan
		// con su categoría propia; se saltea comentarios, directivas, hex,
		// dirección de opcode, [var...] y STRINGS (para no repintarlos).
		const stringRe = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
		const symbolBlockers: { start: number; end: number }[] = [];

		for (const match of text.matchAll(stringRe)) {
			const start = match.index ?? 0;
			symbolBlockers.push({ start, end: start + match[0].length });
		}
		symbolBlockers.push(...exclusions);
		symbolBlockers.sort((a, b) => a.start - b.start);

		let blockerIdx = 0;
		for (const match of text.matchAll(symbolRe)) {
			const start = match.index ?? 0;
			const end = start + match[0].length;

			while (blockerIdx < symbolBlockers.length && symbolBlockers[blockerIdx].end <= start) {
				blockerIdx++;
			}
			if (blockerIdx < symbolBlockers.length && symbolBlockers[blockerIdx].start < end) {
				continue;
			}

			push(CATEGORY_SYMBOLS, range(start, end));
		}

		// Tokens principales. Los tokens vienen en orden ascendente de offset,
		// así que las exclusiones ordenadas se barren con un único puntero.
		const tokens = new Tokenizer().tokenize(text);
		let exclIdx = 0;

		for (const token of tokens) {
			if (token.kind === TokenKind.NewLine || token.kind === TokenKind.EOF) {
				continue;
			}

			const start = lineStarts[token.line - 1] + token.col;
			const end = start + token.text.length;

			while (exclIdx < exclusions.length && exclusions[exclIdx].end <= start) {
				exclIdx++;
			}

			if (exclIdx < exclusions.length && exclusions[exclIdx].start < end) {
				continue;
			}

			const category = this.classifyToken(token);
			if (category) {
				push(category, range(start, end));
			}
		}

		return byCategory;
	}

	private classifyToken(token: Token): string | undefined {
		switch (token.kind) {
			case TokenKind.Number:
			case TokenKind.Float:
				return CATEGORY_NUMBERS;

			case TokenKind.String:
				return CATEGORY_STRINGS;

			case TokenKind.GlobalVar:
			case TokenKind.LocalVar:
				return CATEGORY_VARIABLES;

			case TokenKind.LabelJump:
			case TokenKind.LabelDefine:
				return CATEGORY_LABELS;

			case TokenKind.Model:
				// #ESPERANT, #AK47... referencias a modelos/constantes (#prefijo).
				return CATEGORY_MODELS;

			case TokenKind.Dot:
				// Operador de acceso (char.IsInAir) — siempre texto base.
				return CATEGORY_PLAINTEXT;

			case TokenKind.Identifier: {
				const word = token.text.toLowerCase();

				if (KEYWORDS_IF.has(word)) {
					// Condicionales y cierre de estructuras (if/then/else/end).
					return CATEGORY_KEYWORDS_IF;
				}

				if (KEYWORDS_SWITCH.has(word)) {
					// Estructuras de decisión múltiple (switch/case/default).
					return CATEGORY_KEYWORDS_SWITCH;
				}

				if (KEYWORDS_LOOP.has(word)) {
					// Bucles y saltos de control (while/for/repeat/until...).
					return CATEGORY_KEYWORDS_LOOP;
				}

				if (KEYWORDS_BOOLEAN.has(word)) {
					// Constantes booleanas.
					return CATEGORY_KEYWORDS_BOOLEAN;
				}

				if (KEYWORDS.has(word)) {
					return CATEGORY_KEYWORDS;
				}

				if (this.memberNames.has(word)) {
					return CATEGORY_COMMANDS;
				}

				if (this.className.has(word)) {
					return CATEGORY_CLASSES;
				}

				if (this.enumNames.has(word)) {
					return CATEGORY_ENUMS;
				}

				// Texto base sin relación con objetos (nombres de opcodes
				// sueltos como wait/load_scene/create_char, etc.).
				return CATEGORY_PLAINTEXT;
			}

			default:
				return undefined;
		}
	}

	private buildLineStarts(text: string): number[] {
		const starts = [0];
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n') {
				starts.push(i + 1);
			}
		}
		return starts;
	}

	private positionAt(lineStarts: number[], offset: number): vscode.Position {
		let lo = 0;
		let hi = lineStarts.length - 1;

		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}

		return new vscode.Position(lo, offset - lineStarts[lo]);
	}
}