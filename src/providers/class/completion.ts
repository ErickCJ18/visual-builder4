import { Command, CommandArgs, CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { CompletionItemKind } from 'vscode';
import { BUILTIN_CLASSES, BUILTIN_CLASS_MEMBERS } from '../../builders/builtin-library';
import { BaseProvider } from '../base';
import { ClassProvider } from './class';

export class ClassCompletionProvider extends Singleton {
	private class: ClassProvider = ClassProvider.getInstance();
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	/**
	 * Snippet de invocación del método con lugar para cada argumento:
	 *
	 *     Car.SetCruiseSpeed(${1:speed: float})
	 *
	 * El receptor (`self`, el objeto/variable escrito antes del `.`) NO se
	 * incluye como argumento: ya está en la línea. Los placeholders van en el
	 * ORDEN de la definición (Tab las recorre) y muestran nombre + tipo.
	 */
	private memberInsert(command: Command): vscode.SnippetString {
		const member = command.member ?? '';
		const args = (command.input ?? []).filter(a => a.name !== 'self');

		if (args.length === 0) {
			return new vscode.SnippetString(`${member}($0)`);
		}

		const parts = args.map((arg, idx) => {
			const label = [arg.name, arg.type].filter(Boolean).join(': ') || '?';
			return `\${${idx + 1}:${this.escapeSnippet(label)}}`;
		});

		// `$0` tras el cierre: después del último argumento, Tab sale del
		// paréntesis para seguir escribiendo de frente.
		return new vscode.SnippetString(`${member}(${parts.join(', ')})$0`);
	}

	private memberInsertFallback(member: string): vscode.SnippetString {
		return new vscode.SnippetString(`${member}($0)`);
	}

	/**
	 * Firma completa para la lista de completado: TODOS los argumentos
	 * incluido el receptor `self` (indica qué objeto/variable recibe y de qué
	 * tipo; `self` es la variable escrita antes del punto).
	 */
	private signature(command: Command): string {
		const member = command.member ?? '';
		const params = (command.input ?? []).map(arg => this.formatArg(arg)).join(', ');
		return `${member}(${params})`;
	}

	private formatArg(arg: CommandArgs): string {
		const name = arg.name || '?';
		return arg.type ? `${name}: ${arg.type}` : name;
	}

	/**
	 * Documentación markdown del método: firma en bloque de código, descripción
	 * y detalle de cada argumento (orden, nombre, tipo, receptor).
	 */
	private memberDocumentation(command: Command): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportHtml = false;
		md.isTrusted = false;

		md.appendMarkdown('```sb\n');
		md.appendMarkdown(this.signature(command));
		md.appendMarkdown('\n```\n');

		if (command.shortDesc) {
			md.appendMarkdown(`\n${command.shortDesc}\n`);
		}

		const args = command.input ?? [];
		if (args.length > 0) {
			md.appendMarkdown('\n| # | arg | tipo |\n|---|---|---|\n');
			args.forEach((arg, idx) => {
				const isReceiver = arg.name === 'self';
				const name = arg.name || '?';
				const type = arg.type || '?';
				const position = isReceiver ? '—' : `${idx + 1}`;
				// En la tabla se usa * para la negrita (markdown de VS Code).
				const marker = isReceiver ? '*' : '';
				md.appendMarkdown(`| ${marker}${position}${marker} | ${marker}${name}${marker} | ${type} |\n`);
			});
			md.appendMarkdown('\n*`self`* = la variable/objeto escrito antes del punto (receptor); va PRIMERO*');
		}

		return md;
	}

	/**
	 * Escapa caracteres con significado en el texto de un placeholder de
	 * snippet (`$`, `{`, `}`, `\`) para que se muestren tal cual.
	 */
	private escapeSnippet(text: string): string {
		return text.replace(/([\\${}])/g, '\\$1');
	}

		public register() {
		const provider: vscode.CompletionItemProvider = {
			provideCompletionItems: (doc, pos, _token, _context) => {

				const classesMembers = this.class.get();

				const lineText = doc.lineAt(pos.line).text;
				const textBeforeCursor = lineText.slice(0, pos.character);

				const classMatch = textBeforeCursor.match(/(\w+)\.$/);

				if (classMatch) {
					const className = classMatch[1];

					// Métodos de la clase: primero los datos REALES del juego
					// (sa.json cargado); si la clase no aparece (no hay
					// carpeta/versión SB4 seleccionada), cae al fallback
					// integrado para que Text. / Char. / Camera. sigan
					// sugiriendo sus métodos.
					const members = classesMembers.get(className);

					if (members) {
						return members.map((command, idx) => {
							const item = new vscode.CompletionItem(
								command.member!,
								CompletionItemKind.Method
							);

							item.detail = `(Class member) ${className}.${this.signature(command)}`;
							item.documentation = this.memberDocumentation(command);
							item.sortText = String(idx).padStart(6, '0');
							item.insertText = this.memberInsert(command);

							return item;
						});
					}

					const builtinMembers = BUILTIN_CLASS_MEMBERS[className];
					if (builtinMembers) {
						return builtinMembers.map((member, idx) => {
							const item = new vscode.CompletionItem(
								member,
								CompletionItemKind.Method
							);

							item.detail = `(Class member) ${className}.${member}()`;
							item.sortText = String(idx).padStart(6, '0');
							item.insertText = this.memberInsertFallback(member);

							return item;
						});
					}

					return [];
				}

				// Sin `.` → lista de nombres de clase (reales + fallback).
				const known = new Map(classesMembers);
				for (const className of BUILTIN_CLASSES) {
					if (!known.has(className)) {
						known.set(className, []);
					}
				}

				return [...known.keys()].map(className => {
					const item = new vscode.CompletionItem(
						className,
						CompletionItemKind.Class
					);
					item.detail = 'Class';
					return item;
				});
			}
		};

		this.baseProvider.context.subscriptions.push(vscode.languages.registerCompletionItemProvider(CONFIG.LANGUAGE_SELECTOR, provider, '.'));
	}
}