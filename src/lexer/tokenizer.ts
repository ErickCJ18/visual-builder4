import { Singleton } from '@utils';
import { Token } from './token';
import { TokenKind } from './token-kind';

const singleCharTokens: Record<string, TokenKind> = {
	'(': TokenKind.OpenRoundBracket,
	')': TokenKind.CloseRoundBracket,
	'[': TokenKind.OpenSquareBracket,
	']': TokenKind.CloseSquareBracket,
	'=': TokenKind.Equals,
	',': TokenKind.Comma,
	'.': TokenKind.Dot,
};

const multiCharTokens: Record<string, TokenKind> = {
	'==': TokenKind.EqualEqual,
	'+=': TokenKind.PlusEquals,
	'-=': TokenKind.MinusEquals
};

const prefixCharTokens: Record<string, TokenKind> = {
	'@': TokenKind.LabelJump,
	':': TokenKind.LabelDefine,
	'$': TokenKind.GlobalVar,
	'#': TokenKind.Model
};

const isSpaceChar = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';
const isDigitChar = (c: string): boolean => c >= '0' && c <= '9';
const isWordChar = (c: string): boolean =>
	(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || isDigitChar(c);
const isIdentStartChar = (c: string): boolean =>
	(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

export class Tokenizer extends Singleton {
	private tokens: Token[] = [];

	private push(kind: TokenKind, text: string, line: number, col: number) {
		this.tokens.push({
			kind: kind,
			text: text,
			line: line,
			col: col
		});
	}

	private pushPrefix(line: string, kind: TokenKind, lineNum: number, col: number) {
		const start = col;

		if (prefixCharTokens[line[col]] !== undefined) {
			col++;
		}

		while (col < line.length && isWordChar(line[col])) {
			col++;
		}

		this.push(kind, line.slice(start, col), lineNum + 1, start);
		return col;
	}

	/**
	 * Detecta un número con postfijo (variable local "25@" o tamaño de array).
	 * Devuelve la nueva posición si hubo postfijo, o undefined si son dígitos
	 * "planos" (en ese caso el llamador los trata como número/float).
	 */
	private tryPushPostfix(line: string, lineNum: number, col: number): number | undefined {
		const start = col;
		let cursor = col;

		while (cursor < line.length && isDigitChar(line[cursor])) {
			cursor++;
		}

		const next = line[cursor];

		if (next === '@') {
			this.push(TokenKind.LocalVar, line.slice(start, cursor + 1), lineNum + 1, start);
			return cursor + 1;
		}

		// Postfijo de tamaño de array ("ifsv").
		if (next !== undefined && 'ifsv'.includes(next)) {
			this.push(TokenKind.ArraySize, line.slice(start, cursor + 1), lineNum + 1, start);
			return cursor + 1;
		}

		return undefined;
	}

	/**
	 * Consume un número entero o decimal (p.ej. "90.5") y lo emite como token.
	 */
	private pushNumberOrFloat(line: string, lineNum: number, col: number): number {
		const start = col;
		let hasDot = false;

		while (col < line.length) {
			const c = line[col];

			if (isDigitChar(c)) {
				col++;
				continue;
			}

			if (c === '.' && !hasDot && isDigitChar(line[col + 1] ?? '')) {
				hasDot = true;
				col++;
				continue;
			}

			break;
		}

		this.push(hasDot ? TokenKind.Float : TokenKind.Number, line.slice(start, col), lineNum + 1, start);
		return col;
	}

	public tokenize(text: string): Token[] {
		const lines = text.split(/\r?\n/);

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum];
			let col = 0;

			while (col < line.length) {
				const char = line[col];

				if (isSpaceChar(char)) {
					col++;
					continue;
				}

				// line-comment
				if (char === '/' && line[col + 1] === '/') {
					break;
				}

				const singleCharKind = singleCharTokens[char];
				if (singleCharKind !== undefined && line[col + 1] !== char) {
					this.push(singleCharKind, char, lineNum + 1, col);
					col++;
					continue;
				}

				for (const [str, kind] of Object.entries(multiCharTokens)) {
					let matches = 0;

					for (const c of str) {
						if (c === line[col]) {
							matches++;
							col++;
						}
					}

					if (matches === str.length) {
						this.push(kind, str, lineNum + 1, col);
					}
				}

				const prefixCharKind = prefixCharTokens[char];
				if (prefixCharKind !== undefined) {
					col = this.pushPrefix(line, prefixCharKind, lineNum, col);
					continue;
				}

				// local var "25@" / array size (si hay postfijo), o número
				// plano (entero/float) si no lo hay.
				if (isDigitChar(char)) {
					col = this.tryPushPostfix(line, lineNum, col) ?? this.pushNumberOrFloat(line, lineNum, col);
					continue;
				}

				// identifier
				if (isIdentStartChar(char)) {
					col = this.pushPrefix(line, TokenKind.Identifier, lineNum, col);
					continue;
				}

				// string
				if (char === '\'' || char === '\"') {
					const start = col;
					col++;

					let str: string = "";
					str += char;

					while (col < line.length) {
						const c = line[col];

						if (c === '\\') {
							const next = line[col + 1];
							if (next !== undefined) {
								str += c + next;
								col += 2;
								continue;
							}
						}

						if (c === char) {
							col++;
							str += c;
							break;
						}

						str += c;
						col++;
					}

					this.push(TokenKind.String, str, lineNum + 1, start);
					continue;
				}

				col++;
			}

			// EOL
			this.push(TokenKind.NewLine, '\n', lineNum + 1, line.length);
		}

		// EOF
		this.push(TokenKind.EOF, '', lines.length + 1, 0);
		return this.tokens;
	}
};