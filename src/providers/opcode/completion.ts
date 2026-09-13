import { Command, CommandArgs, CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { CompletionItemKind } from 'vscode';
import { KEYWORDS } from '../syntax/syntax-coloring-provider';
import { BaseProvider } from '../base';
import { OpcodeProvider } from './opcode';
import { buildOpcodeLine, formatOpcodeArg } from './format';

export class OpcodeCompletionProvider extends Singleton {
	private opcode: OpcodeProvider = OpcodeProvider.getInstance();
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	public register() {
		const provider: vscode.CompletionItemProvider = {
			provideCompletionItems: (document, position, _token, context) => {
				const opcodes = this.opcode.get();
				const word = this.getCurrentWord(document, position);
				const isDotTrigger =
					context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
					context.triggerCharacter === '.';
				const isInvoke = context.triggerKind === vscode.CompletionTriggerKind.Invoke;

				// Tras un "." los miembros los aporta el provider de clases.
				if (isDotTrigger) {
					return [];
				}

				// Si no hay palabra en curso, solo se listan con Ctrl+Space.
				if (word.length === 0 && !isInvoke) {
					return [];
				}

				// Palabras clave (if, then, end, while...) nunca disparan opcodes:
				// evita que Enter seleccione un opcode no deseado.
				if (KEYWORDS.has(word)) {
					return [];
				}

				const items = [...opcodes.keys()].flatMap(opcodeName => {
					const overloads = opcodes.get(opcodeName) ?? [];
					const command = overloads[0];

					// Opcodes no soportados o NOP no se sugieren nunca
					// (regla cleo-ai: avoid unsupported/nop opcodes).
					if (command.attrs?.isUnsupported || command.attrs?.isNop) {
						return [];
					}

					const result = [
						this.buildNameItem(opcodeName, overloads)
					];

					// Permite completar el opcode entero escribiendo solo su
					// código (ej: 009a -> create_char).
					if (command?.id) {
						result.push(this.buildCodeItem(opcodeName, overloads, command));
					}

					return result;
				});

				// Con tecleo automático solo se devuelven coincidencias reales
				// con la palabra escrita, para que la lista no se dispare.
				if (!isInvoke) {
					return items.filter(item => this.itemFilterText(item).includes(word));
				}

				return items;
			}
		};

		this.baseProvider.context.subscriptions.push(vscode.languages.registerCompletionItemProvider(CONFIG.LANGUAGE_SELECTOR, provider, '.'));
	}

	private getCurrentWord(document: vscode.TextDocument, position: vscode.Position): string {
		const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
		return (linePrefix.match(/[A-Za-z0-9_]*$/)?.[0] ?? '').toLowerCase();
	}

	private itemFilterText(item: vscode.CompletionItem): string {
		return String(item.filterText ?? item.label).toLowerCase();
	}

	private buildNameItem(opcodeName: string, overloads: Command[]): vscode.CompletionItem {
		const command = overloads[0];

		const item = new vscode.CompletionItem(
			opcodeName,
			CompletionItemKind.Function
		);

		item.insertText = this.buildDefaultLine(command);
		item.detail = this.buildDetail(opcodeName, overloads);
		item.documentation = this.buildDocumentation(command, overloads);

		return item;
	}

	private buildCodeItem(opcodeName: string, overloads: Command[], command: Command): vscode.CompletionItem {
		const id = command.id ?? '';

		const item = new vscode.CompletionItem(
			`${id}: ${opcodeName}`,
			CompletionItemKind.Function
		);

		item.filterText = id.toLowerCase();
		item.insertText = this.buildDefaultLine(command);
		item.detail = this.buildDetail(id, overloads);
		item.documentation = this.buildDocumentation(command, overloads);

		return item;
	}

	private buildDefaultLine(command: Command): string {
		return buildOpcodeLine(command);
	}

	private formatArg(arg: CommandArgs): string {
		return formatOpcodeArg(arg);
	}

	private formatCommand(command: Command): string {
		return this.buildDefaultLine(command);
	}

	private buildDetail(opcodeName: string, overloads: Command[]): string {
		const params = (overloads[0]?.input ?? []).map(a => this.formatArg(a)).join(' ');
		return `(Opcode) ${opcodeName} ${params}`.trimEnd();
	}

	private buildDocumentation(command: Command, overloads: Command[]): vscode.MarkdownString {
		const markdown = new vscode.MarkdownString();
		markdown.appendMarkdown('```sb\n');
		markdown.appendMarkdown(this.formatCommand(command));
		markdown.appendMarkdown('\n```\n\n');

		if (command.shortDesc) {
			markdown.appendMarkdown(command.shortDesc);
		}

		if (overloads.length > 1) {
			markdown.appendMarkdown(`\n\n**${overloads.length} variantes:**`);
			overloads.forEach(overload => markdown.appendMarkdown(`\n- \`${this.formatCommand(overload)}\``));
		}

		return markdown;
	}
}