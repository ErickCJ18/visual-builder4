import { CommandManager } from '@managers';
import { CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { Token } from '../../lexer/token';
import { TokenKind } from '../../lexer/token-kind';
import { Tokenizer } from '../../lexer/tokenizer';
import { BUILTIN_CLASSES, BUILTIN_CLASS_MEMBERS } from '../../builders/builtin-library';
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
// AND/OR también van aquí: dentro de un IF (if ... and ... / or ...) deben
// colorearse como keywordsIf, como el resto de la condición.
export const KEYWORDS_IF = new Set([
	'if', 'then', 'else', 'elsif', 'endif', 'end', 'and', 'or'
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

// Tipos de variable de SB4 y PATRONES de declaración tipada: "int 0@",
// "float speed", bloque "var ... end" con "nombre: tipo" y "[var nombre: tipo]".
// El NOMBRE declarado se recuerda por documento y cada uso posterior se colorea
// como variable (los nombres numéricos 0@/$var ya se colorean por token).
const DECL_TYPES = '(?:int|float|double|bool|boolean|char|integer|long|short|longstring|shortstring|string|byte|word|dword|array|struct|handle)';
// "int speed" / "float 0@" — tipo seguido del nombre. El lookahead excluye
// keywords/tipos como falso-nombre (p. ej. "int 0@: int oneLine: int end" no
// debe declarar "end").
const DECL_TYPE_NAME_RE = new RegExp(`\\b${DECL_TYPES}\\s+(?!(?:var|end|${DECL_TYPES})\\b)([A-Za-z_]\\w*)`, 'g');
// "  speed: int", "  speed = 0.0: float", "  speed[10]: int" — dentro de
// bloques var ... end. El nombre puede ir seguido de un inicializador
// (= valor, array [n]) antes del ':'. `(?:^|\s)` exige un límite previo (un
// '$' delante → no matchea "global" de "$global"), y el lookahead rechaza
// keywords/tipos como falso-nombre.
const DECL_NAME_TYPE_RE = new RegExp(`(?:^|\\s)(?!(?:var|end|${DECL_TYPES})\\b)([A-Za-z_]\\w*)\\s*[^:\\n]*?:\\s*${DECL_TYPES}\\b`, 'g');
// "[var speed: int]" — anotación de variables de la extensión.
const DECL_BRACKET_RE = /\[var\s+([A-Za-z_]\w*)\s*:/gi;

// ~0: el análisis es incremental (por línea) y cada tecla se repinta al
// instante; el debounce solo evita hacer trabajo redundante dentro de una
// misma ráfaga de tipeo.
const DEBOUNCE_MS = 16;

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
 *
 * Rendimiento: el documento se analiza POR LÍNEA (el estado de comentarios
 * de bloque/llaves se arrastra línea a línea) y cada edición de una sola
 * línea re-analiza SOLO esa línea (y, si cambió la continuidad de un
 * comentario, las siguientes hasta que el estado se re-estabiliza). Así el
 * coloreo es instantáneo incluso en archivos enormes (main.scm de 44k líneas).
 */
export class SyntaxColoringProvider extends Singleton {
	private baseProvider: BaseProvider = BaseProvider.getInstance();
	private colorManager: SyntaxColorManager = SyntaxColorManager.getInstance();
	private decorations = new Map<string, vscode.TextEditorDecorationType>();
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private paints = new Map<string, DocPaint>();

	// Variables NOMBRADAS declaradas con tipo (int speed, bloque var...end,
	// [var x: int]) por documento (uri → nombres en minúsculas). Se siembran en
	// el análisis completo y se actualizan en ediciones incrementales.
	private declaredVars = new Map<string, Set<string>>();

	private memberNames = new Set<string>();
	private className = new Set<string>();
	private enumNames = new Set<string>();
	private opcodeNames = new Set<string>();

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
		this.paints.clear();
		this.applyToVisibleEditors();
	}

	private buildLookups() {
		// La categoría "commands" colorea SOLO los métodos de clase (el miembro
		// de "char.IsInAir" / "camera.Shake"), no los nombres sueltos de
		// opcodes (wait, load_scene, create_char) que van sin color.
		//
		// Fallback integrado: si la librería del juego no está cargada (falta
		// carpeta/versión de SB4 en la statusbar), las clases (Text, Char,
		// Car...) y su método "X.Y" siguen coloreándose/completándose. La
		// librería REAL, si cargan, se fusiona por encima del fallback.
		this.memberNames.clear();
		this.opcodeNames.clear();

		for (const members of Object.values(BUILTIN_CLASS_MEMBERS)) {
			for (const member of members) {
				this.memberNames.add(member.toLowerCase());
			}
		}

		for (const command of CommandManager.getInstance().getCommands().values()) {
			if (command.member) {
				this.memberNames.add(command.member.toLowerCase());
			}
			if (command.name) {
				this.opcodeNames.add(command.name.toLowerCase());
			}
		}

		// Clases: siembra con el fallback integrado y luego se fusionan las
		// clases reales del juego (sa.json).
		this.className.clear();
		for (const name of BUILTIN_CLASSES) {
			this.className.add(name.toLowerCase());
		}
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
			vscode.workspace.onDidOpenTextDocument(doc => this.apply(doc)),
			vscode.workspace.onDidChangeTextDocument(event => this.scheduleIncremental(event)),
			vscode.workspace.onDidCloseTextDocument(doc => {
				this.clearTimer(doc.uri.toString());
				this.paints.delete(doc.uri.toString());
				this.declaredVars.delete(doc.uri.toString());
			}),
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

	// Aplica el coloreo inmediatamente (sin debounce) para un documento SB.
	private apply(document: vscode.TextDocument) {
		if (document.languageId !== CONFIG.LANGUAGE_SELECTOR.language) {
			return;
		}
		this.getPaint(document);
		this.paintEditors(document.uri);
	}

	private scheduleIncremental(event: vscode.TextDocumentChangeEvent) {
		if (event.document.languageId !== CONFIG.LANGUAGE_SELECTOR.language) {
			return;
		}

		const key = event.document.uri.toString();
		this.clearTimer(key);

		this.debounceTimers.set(key, setTimeout(() => {
			this.debounceTimers.delete(key);
			this.repaintChangedDocument(event);
		}, DEBOUNCE_MS));
	}

	private clearTimer(key: string) {
		const existing = this.debounceTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(key);
		}
	}

	// ------------------------------------------------------------------
	// Pintado
	// ------------------------------------------------------------------

	private applyToVisibleEditors() {
		vscode.window.visibleTextEditors.forEach(editor => {
			if (this.isSbEditor(editor)) {
				this.applyToEditor(editor);
			}
		});
	}

	/**
	 * Colorea (o recolorea) EL editor dado. Público: también se usa para
	 * repintar la pestaña virtual justo después de que setTextDocumentLanguage
	 * hace efectivo el language 'sannybuilder' (ahí no se emite ningún otro
	 * evento que dispare la reaplicación).
	 */
	public applyToEditor(editor: vscode.TextEditor) {
		const paint = this.getPaint(editor.document);
		for (const [category, decorationType] of this.decorations) {
			editor.setDecorations(decorationType, paint.catRanges.get(category) ?? []);
		}
	}

	private getPaint(document: vscode.TextDocument): DocPaint {
		let paint = this.paints.get(document.uri.toString());
		if (!paint) {
			paint = this.analyze(document.getText(), document.uri.toString());
			this.paints.set(document.uri.toString(), paint);
		}
		return paint;
	}

	private paintEditors(uri: vscode.Uri, paint?: DocPaint) {
		const target = paint ?? this.paints.get(uri.toString());
		if (!target) {
			return;
		}
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uri.toString()) {
				for (const [category, decorationType] of this.decorations) {
					editor.setDecorations(decorationType, target.catRanges.get(category) ?? []);
				}
			}
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
	// Análisis por línea (full e incremental compartido)
	// ------------------------------------------------------------------

	// Analiza el documento completo, línea a línea, arrastrando el estado de
	// comentarios de bloque/llaves. Devuelve el "render" agregado. `docKey`
	// identifica el documento para la lista de variables declaradas (int/float).
	private analyze(text: string, docKey: string): DocPaint {
		this.declaredVars.set(docKey, this.collectDeclaredVars(text));
		const declared = this.declaredVars.get(docKey)!;

		const pieces = text.split(/\r?\n/);
		const lines: LineRender[] = [];
		let inBlock = false;
		let inBrace = false;
		let prevDot = false;

		for (let lineIndex = 0; lineIndex < pieces.length; lineIndex++) {
			const render = this.analyzeLine(lineIndex, pieces[lineIndex], inBlock, inBrace, prevDot, declared);
			inBlock = render.blockOut;
			inBrace = render.braceOut;
			prevDot = render.endsWithDot;
			lines.push(render);
		}

		const catRanges = new Map<string, vscode.Range[]>();
		for (const render of lines) {
			for (const [category, ranges] of render.categories) {
				let arr = catRanges.get(category);
				if (!arr) {
					arr = [];
					catRanges.set(category, arr);
				}
				for (const r of ranges) {
					arr.push(r);
				}
			}
		}

		return { lines, texts: pieces, catRanges };
	}

	/**
	 * Analiza UNA línea y devuelve sus rangos por categoría + el estado de
	 * "comentario abierto" que deja (para la siguiente línea) + si termina
	 * en un '.'. `blockIn`/`braceIn` indican si la línea arranca DENTRO de un
	 * comentario de bloque (/* *\/) o de llaves ({ ... }) heredado de la línea
	 * anterior; `prevDot` si la línea anterior terminó con un punto (acceso
	 * Text.Draw repartido en dos líneas).
	 */
	private analyzeLine(
		lineIndex: number,
		lineText: string,
		blockIn: boolean,
		braceIn: boolean,
		prevDot: boolean,
		declared: Set<string>
	): LineRender {
		const categories = new Map<string, vscode.Range[]>();
		const exclusions: { start: number; end: number }[] = [];

		const add = (category: string, localStart: number, localEnd: number) => {
			let arr = categories.get(category);
			if (!arr) {
				arr = [];
				categories.set(category, arr);
			}
			arr.push(new vscode.Range(new vscode.Position(lineIndex, localStart), new vscode.Position(lineIndex, localEnd)));
		};
		const exclude = (localStart: number, localEnd: number) => {
			exclusions.push({ start: localStart, end: localEnd });
		};
		const addExcluded = (category: string, localStart: number, localEnd: number) => {
			add(category, localStart, localEnd);
			exclude(localStart, localEnd);
		};

		// --- Comentarios (//, /* */, {...}) — reconocidos por escáner para
		// poder arrastrar el estado entre líneas (los bloque/llaves pueden
		// abrir en una línea y cerrar 500 líneas después). Los openers se
		// incluyen en el rango del comentario (/*, {).
		let restBlock = blockIn;
		let restBrace = braceIn;
		let blockOut = blockIn;
		let braceOut = braceIn;
		let blockOpenAt = -1;
		let braceOpenAt = -1;
		let i = 0;
		const len = lineText.length;

		while (i < len) {
			if (restBlock) {
				const start = blockOpenAt >= 0 ? blockOpenAt : i;
				const close = lineText.indexOf('*/', i);
				if (close === -1) {
					addExcluded(CATEGORY_COMMENTS, start, len);
					blockOut = true;
					break;
				}
				addExcluded(CATEGORY_COMMENTS, start, close + 2);
				restBlock = false;
				blockOut = false;
				blockOpenAt = -1;
				i = close + 2;
				continue;
			}
			if (restBrace) {
				const start = braceOpenAt >= 0 ? braceOpenAt : i;
				const close = lineText.indexOf('}', i);
				if (close === -1) {
					addExcluded(CATEGORY_COMMENTS, start, len);
					braceOut = true;
					break;
				}
				addExcluded(CATEGORY_COMMENTS, start, close + 1);
				restBrace = false;
				braceOut = false;
				braceOpenAt = -1;
				i = close + 1;
				continue;
			}
			if (lineText[i] === '/' && lineText[i + 1] === '/') {
				addExcluded(CATEGORY_COMMENTS, i, len);
				break;
			}
			if (lineText[i] === '/' && lineText[i + 1] === '*') {
				restBlock = true;
				blockOut = true;
				blockOpenAt = i;
				i += 2;
				continue;
			}
			if (lineText[i] === '{' && lineText[i + 1] !== '$') {
				restBrace = true;
				braceOut = true;
				braceOpenAt = i;
				i += 1;
				continue;
			}
			i++;
		}

		// --- Strings (solo como bloqueadores de símbolos; los tokens de
		// strings se pintan con el tokenizer).
		const stringRe = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
		const symbolBlockers: { start: number; end: number }[] = [];
		stringRe.lastIndex = 0;
		for (const match of lineText.matchAll(stringRe)) {
			const start = match.index ?? 0;
			symbolBlockers.push({ start, end: start + match[0].length });
		}

		// --- Números NEGATIVOS: el signo '-' ya lo incluye el token del número
		// (categoría numbers); se bloquea para que el pasaje de symbols no lo
		// repinte encima como operador de resta.
		const signedNumberRe = /-\d+(?:\.\d+)?|-\.\d+/g;
		signedNumberRe.lastIndex = 0;
		for (const match of lineText.matchAll(signedNumberRe)) {
			const start = match.index ?? 0;
			symbolBlockers.push({ start, end: start + match[0].length });
		}

		// --- Números hexadecimales (0x...) — se excluyen del tokenizer para
		// que no repinte el dígito suelto "0".
		const hexRe = /\b0x[0-9A-Fa-f]+\b/g;
		hexRe.lastIndex = 0;
		for (const match of lineText.matchAll(hexRe)) {
			const start = match.index ?? 0;
			addExcluded(CATEGORY_NUMBERS, start, start + match[0].length);
		}

		// --- Directivas: {$...}
		const directiveRe = /\{\$[^}\n]*\}/g;
		directiveRe.lastIndex = 0;
		for (const match of lineText.matchAll(directiveRe)) {
			const start = match.index ?? 0;
			addExcluded(CATEGORY_DIRECTIVES, start, start + match[0].length);
		}

		// --- Dirección de opcode al inicio: texto base (plainText), nunca
		// command (solo los métodos de clase, char.IsInAir, llevan commands).
		const addressMatch = /^(\s*[0-9A-Fa-f]{2,4}\s*:)/.exec(lineText);
		if (addressMatch) {
			addExcluded(CATEGORY_PLAINTEXT, 0, addressMatch[1].length);
		}

		// --- Declaraciones [var nombre: Tipo] (nombre puede ser "0@", "$var"
		// o identificador; "var" en mayúsculas o minúsculas).
		const varDeclRe = /\[var\s+([^\s:]+?)\s*:\s*([A-Za-z_]\w*)\]/gi;
		varDeclRe.lastIndex = 0;
		for (const match of lineText.matchAll(varDeclRe)) {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			exclude(start, end);

			const nameOffset = start + match[0].indexOf(match[1]);
			add(CATEGORY_VARIABLES, nameOffset, nameOffset + match[1].length);

			const typeOffset = start + match[0].lastIndexOf(match[2]);
			add(CATEGORY_CLASSES, typeOffset, typeOffset + match[2].length);
		}

		exclusions.sort((a, b) => a.start - b.start);

		// --- Símbolos de programación (==, =, >, <, +, -, *, /...). Se
		// saltean comentarios, directivas, hex, dirección, [var...] y strings.
		symbolBlockers.push(...exclusions);
		symbolBlockers.sort((a, b) => a.start - b.start);

		symbolRe.lastIndex = 0;
		let blockerIdx = 0;
		for (const match of lineText.matchAll(symbolRe)) {
			const start = match.index ?? 0;
			const end = start + match[0].length;

			while (blockerIdx < symbolBlockers.length && symbolBlockers[blockerIdx].end <= start) {
				blockerIdx++;
			}
			if (blockerIdx < symbolBlockers.length && symbolBlockers[blockerIdx].start < end) {
				continue;
			}

			add(CATEGORY_SYMBOLS, start, end);
		}

		// --- Tokens principales (solo esta línea; el estado cruzado lo
		// arrastran blockIn/braceIn/prevDot).
		const tokens = new Tokenizer().tokenize(lineText);
		let exclIdx = 0;
		let prev: Token | undefined;

		for (const token of tokens) {
			if (token.kind === TokenKind.NewLine || token.kind === TokenKind.EOF) {
				continue;
			}

			const start = token.col;
			const end = start + token.text.length;

			while (exclIdx < exclusions.length && exclusions[exclIdx].end <= start) {
				exclIdx++;
			}
			if (exclIdx < exclusions.length && exclusions[exclIdx].start < end) {
				prev = token;
				continue;
			}

			const dotBefore = prev ? prev.kind === TokenKind.Dot : prevDot;
			const category = this.classifyToken(token, dotBefore, declared);
			if (category) {
				add(category, start, end);
			}

			prev = token;
		}

		return {
			categories,
			blockOut,
			braceOut,
			endsWithDot: prev?.kind === TokenKind.Dot
		};
	}

	private classifyToken(token: Token, dotBefore: boolean, declared: Set<string>): string | undefined {
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

				// Variable declarada con su tipo (int speed, bloque var...end,
				// [var x: int]): TODO uso (declaración + usos posteriores) se
				// mantiene como variable aunque el token sea un identificador
				// común, sin importar que coincida con opcodes/clases/enums.
				if (declared.has(word)) {
					return CATEGORY_VARIABLES;
				}

				// Nombres sueltos de opcodes (wait, goto, load_scene,
				// create_char...) van como texto base, no como commands/enums.
				if (this.opcodeNames.has(word)) {
					return CATEGORY_PLAINTEXT;
				}

				// Los métodos de clase (member) SOLO se colorean como commands
				// cuando son acceso real: char.IsInAir. Un miembro suelto
				// (jump, IsInAir...) es un nombre de opcode → texto base.
				//
				// ORDEN IMPORTANTE: la clase se chequea ANTES que el miembro.
				// Hay miembros cuyo nombre coincide con una CLASE (File,
				// Restart, Text: p.ej. ImGui.IMGUI_TEXT → member "Text") y si
				// el miembro se chequease primero, un 'Text' suelto (uso de
				// clase) caería a plainText. Como clase, el nombre suelto se
				// colorea siempre; solo tras un '.' se colorea como command.
				if (this.className.has(word)) {
					return CATEGORY_CLASSES;
				}

				if (this.memberNames.has(word)) {
					return dotBefore ? CATEGORY_COMMANDS : CATEGORY_PLAINTEXT;
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

	// ------------------------------------------------------------------
	// Variables declaradas con tipo (int/float/...): extracción por documento
	// ------------------------------------------------------------------

	/**
	 * Devuelve la línea con el contenido de comentarios REEMPLAZADO por
	 * espacios (misma longitud), para que las regex de declaración nunca
	 * matcheen dentro de un comentario. El estado de comentarios de bloque
	 * (`/* ... *\/` y `{ ... }`) se arrastra entre líneas.
	 */
	private commentFree(line: string, state: { block: boolean; brace: boolean }): string {
		const out = new Array(line.length);
		let i = 0;
		const len = line.length;

		while (i < len) {
			const ch = line[i];
			const next = line[i + 1];

			if (state.block) {
				out[i] = ' ';
				if (ch === '*' && next === '/') {
					out[i + 1] = ' ';
					i += 2;
					state.block = false;
					continue;
				}
				i++;
				continue;
			}

			if (state.brace) {
				out[i] = ' ';
				if (ch === '}') {
					state.brace = false;
					i++;
					continue;
				}
				i++;
				continue;
			}

			if (ch === '/' && next === '/') {
				while (i < len) {
					out[i] = ' ';
					i++;
				}
				break;
			}

			if (ch === '/' && next === '*') {
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 2;
				state.block = true;
				continue;
			}

			if (ch === '{' && next !== '$') {
				out[i] = ' ';
				state.brace = true;
				i++;
				continue;
			}

			out[i] = ch;
			i++;
		}

		return out.join('');
	}

	/** Nombres declarados en UNA línea (sin estado cruzado de comentarios). */
	private lineDeclarations(line: string): Set<string> {
		const names = new Set<string>();
		const state = { block: false, brace: false };
		const cleaned = this.commentFree(line, state);

		DECL_TYPE_NAME_RE.lastIndex = 0;
		for (const m of cleaned.matchAll(DECL_TYPE_NAME_RE)) {
			names.add(m[1].toLowerCase());
		}
		DECL_NAME_TYPE_RE.lastIndex = 0;
		for (const m of cleaned.matchAll(DECL_NAME_TYPE_RE)) {
			names.add(m[1].toLowerCase());
		}
		DECL_BRACKET_RE.lastIndex = 0;
		for (const m of cleaned.matchAll(DECL_BRACKET_RE)) {
			names.add(m[1].toLowerCase());
		}
		return names;
	}

	private sameDeclarations(a: string, b: string): boolean {
		const sa = this.lineDeclarations(a);
		const sb = this.lineDeclarations(b);
		if (sa.size !== sb.size) {
			return false;
		}
		for (const name of sa) {
			if (!sb.has(name)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Barre TODO el documento y reúne los nombres de variables declaradas con
	 * tipo. Reconoce:
	 *  - "int speed" / "float 0@" (tipo + nombre);
	 *  - "  speed: int" dentro de un bloque `var ... end` (incl. `0@: int = 5`);
	 *  - "[var speed: int]" (anotación de esta extensión).
	 * Respeta comentarios //, de llaves y de bloque (con estado arrastrado).
	 */
	private collectDeclaredVars(text: string): Set<string> {
		const names = new Set<string>();
		const lines = text.split(/\r?\n/);
		const state = { block: false, brace: false };
		let inVar = false;

		for (const line of lines) {
			const cleaned = this.commentFree(line, state);
			const trimmed = cleaned.trim();

			if (/^var\b/i.test(trimmed)) {
				inVar = true;
			}

			DECL_TYPE_NAME_RE.lastIndex = 0;
			for (const m of cleaned.matchAll(DECL_TYPE_NAME_RE)) {
				names.add(m[1].toLowerCase());
			}

			DECL_BRACKET_RE.lastIndex = 0;
			for (const m of cleaned.matchAll(DECL_BRACKET_RE)) {
				names.add(m[1].toLowerCase());
			}

			if (inVar) {
				DECL_NAME_TYPE_RE.lastIndex = 0;
				for (const m of cleaned.matchAll(DECL_NAME_TYPE_RE)) {
					names.add(m[1].toLowerCase());
				}
			}

			if (/\bend\b/i.test(trimmed)) {
				inVar = false;
			}
		}

		return names;
	}

	// ------------------------------------------------------------------
	// Pintado incremental (una tecla = una línea re-analizada)
	// ------------------------------------------------------------------

	/**
	 * Re-renderiza SOLO las líneas afectadas por el cambio. Para ediciones de
	 * una sola línea basta con re-analizar esa línea + (si cambió la
	 * continuidad de un comentario de bloque/llaves) las siguientes hasta que
	 * el estado se re-estabilize. Cambios estructurales (insertar/borrar
	 * líneas, saltos de línea) caen a un análisis completo.
	 */
	private repaintChangedDocument(event: vscode.TextDocumentChangeEvent) {
		const document = event.document;
		const key = document.uri.toString();
		const paint = this.paints.get(key);
		if (!paint) {
			return;
		}

		// Cambio estructural → análisis completo y repintado total.
		if (document.lineCount !== paint.lines.length ||
			event.contentChanges.some(ch => ch.range.start.line !== ch.range.end.line || /[\r\n]/.test(ch.text))) {
			this.paints.set(key, this.analyze(document.getText(), key));
			this.paintEditors(document.uri);
			return;
		}

		const changedLines = [...new Set(event.contentChanges.map(ch => ch.range.start.line))].sort((a, b) => a - b);
		const coveredLines = new Set<number>();
		const affectedCategories = new Set<string>();

		for (const lineIndex of changedLines) {
			if (coveredLines.has(lineIndex)) {
				continue;
			}

			// Si en la línea editada cambió una DECLARACIÓN tipada (se añadió,
			// quitó o renombró "int speed"), el nombre puede usarse en cualquier
			// otra línea → cae a re-análisis completo (la lista declarada del
			// documento se re-barre con la continuidad de comentarios real).
			if (!this.sameDeclarations(paint.texts[lineIndex], document.lineAt(lineIndex).text)) {
				this.paints.set(key, this.analyze(document.getText(), key));
				this.paintEditors(document.uri);
				return;
			}
			paint.texts[lineIndex] = document.lineAt(lineIndex).text;

			// Camina hacia adelante mientras el estado de comentarios cambie;
			// se detiene cuando una línea re-renderizada coincide con su estado
			// almacenado (las siguientes reciben el mismo estado de entrada).
			let inBlock = lineIndex > 0 ? paint.lines[lineIndex - 1].blockOut : false;
			let inBrace = lineIndex > 0 ? paint.lines[lineIndex - 1].braceOut : false;
			let prevDot = lineIndex > 0 ? paint.lines[lineIndex - 1].endsWithDot : false;
			let idx = lineIndex;
			const declared = this.declaredVars.get(key) ?? new Set<string>();

			while (idx < paint.lines.length) {
				const render = this.analyzeLine(idx, document.lineAt(idx).text, inBlock, inBrace, prevDot, declared);
				const stored = paint.lines[idx];
				coveredLines.add(idx);
				paint.texts[idx] = document.lineAt(idx).text;

				// Sustituye los ranges agregados de esta línea y actualiza el
				// estado almacenado (así el pase siguiente ve el render nuevo).
				this.replaceLineRange(paint, idx, stored, render, affectedCategories);
				paint.lines[idx] = render;

				if (render.blockOut === stored.blockOut &&
					render.braceOut === stored.braceOut &&
					render.endsWithDot === stored.endsWithDot) {
					break;
				}

				if (idx + 1 >= paint.lines.length) {
					break;
				}

				inBlock = render.blockOut;
				inBrace = render.braceOut;
				prevDot = render.endsWithDot;
				idx++;
			}
		}

		this.paintCategories(document.uri, paint, affectedCategories);
	}

	private paintCategories(uri: vscode.Uri, paint: DocPaint, categories: Set<string>) {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() !== uri.toString()) {
				continue;
			}
			for (const category of categories) {
				const decoration = this.decorations.get(category);
				if (decoration) {
					editor.setDecorations(decoration, paint.catRanges.get(category) ?? []);
				}
			}
		}
	}

	// Sustituye en el índice dado el range de la AGGREGATED catRanges que
	// pertenecía a esa línea, evitando reconstruir categorías no afectadas.
	private replaceLineRange(
		paint: DocPaint,
		lineIndex: number,
		old: LineRender,
		neu: LineRender,
		affectedCategories: Set<string>
	) {
		const categoriesUnion = new Set<string>([...old.categories.keys(), ...neu.categories.keys()]);
		for (const category of categoriesUnion) {
			affectedCategories.add(category);
			const all = paint.catRanges.get(category);
			if (!all) {
				if (neu.categories.get(category)) {
					paint.catRanges.set(category, [...(neu.categories.get(category) ?? [])]);
				}
				continue;
			}
			const rebuilt = all.filter(r => r.start.line !== lineIndex);
			for (const r of neu.categories.get(category) ?? []) {
				rebuilt.push(r);
			}
			paint.catRanges.set(category, rebuilt);
		}
	}

}

interface LineRender {
	categories: Map<string, vscode.Range[]>;
	blockOut: boolean;
	braceOut: boolean;
	endsWithDot: boolean;
}

interface DocPaint {
	lines: LineRender[];
	texts: string[];
	catRanges: Map<string, vscode.Range[]>;
}