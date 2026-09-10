import { CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { CompletionItemKind } from 'vscode';
import { BaseProvider } from '../base';

interface StructSnippet {
	label: string;
	keyword: string;
	description: string;
	body: string[];
}

const STRUCT_SNIPPETS: StructSnippet[] = [
	{
		label: 'if ... then ... end',
		keyword: 'if',
		description: 'Bloque condicional IF / THEN / END',
		body: [
			'if ${1:condition}',
			'\t${2:then}',
			'end'
		]
	},
	{
		label: 'else (IF/ELSE)',
		keyword: 'else',
		description: 'Rama ELSE de un IF',
		body: [
			'else',
			'\t${1:else}'
		]
	},
	{
		label: 'while ... end',
		keyword: 'while',
		description: 'Bucle WHILE / END',
		body: [
			'while ${1:condition}',
			'\t${2:body}',
			'end'
		]
	},
	{
		label: 'repeat ... until',
		keyword: 'repeat',
		description: 'Bucle REPEAT / UNTIL',
		body: [
			'repeat',
			'\t${1:body}',
			'until ${2:condition}'
		]
	},
	{
		label: 'switch ... case ... end',
		keyword: 'switch',
		description: 'Bloque SWITCH / CASE / END',
		body: [
			'switch ${1:value}',
			'case ${2:case}',
			'\t${3:body}',
			'default',
			'\t${4:default}',
			'end'
		]
	},
	{
		label: 'function ... end',
		keyword: 'function',
		description: 'Función (HIGH-LEVEL)',
		body: [
			'function ${1:name}',
			'\t${2:body}',
			'end'
		]
	}
];

/**
 * Snippets de estructuras de alto nivel (IF/THEN/END, WHILE, REPEAT,
 * SWITCH, FUNCTION...). Aparecen al empezar a escribir la palabra clave
 * y se insertan reemplazándola.
 */
export class SnippetCompletionProvider extends Singleton {
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	public register() {
		const provider: vscode.CompletionItemProvider = {
			provideCompletionItems: (document, position, _token, context) => {
				const range = this.getCurrentWordRange(document, position);
				const word = range ? document.getText(range).toLowerCase() : '';

				// Solo se muestran al teclear la palabra clave (o con Ctrl+Space).
				if (word.length === 0 && context.triggerKind !== vscode.CompletionTriggerKind.Invoke) {
					return [];
				}

				const matching = STRUCT_SNIPPETS.filter(s => word.length === 0 || s.keyword.startsWith(word));

				if (matching.length === 0) {
					return [];
				}

				return matching.map(snippet => this.buildItem(snippet, range));
			}
		};

		this.baseProvider.context.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(CONFIG.LANGUAGE_SELECTOR, provider)
		);
	}

	private getCurrentWordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
		const lineText = document.lineAt(position.line).text;
		const prefix = lineText.slice(0, position.character);
		const match = prefix.match(/[A-Za-z0-9_]+$/)?.[0];

		if (!match) {
			return undefined;
		}

		return new vscode.Range(
			position.with(position.line, position.character - match.length),
			position
		);
	}

	private buildItem(snippet: StructSnippet, range: vscode.Range | undefined): vscode.CompletionItem {
		const item = new vscode.CompletionItem(snippet.label, CompletionItemKind.Snippet);

		item.detail = snippet.description;
		item.documentation = new vscode.MarkdownString('```sb\n' + snippet.body.join('\n') + '\n```');
		item.insertText = new vscode.SnippetString(snippet.body.join('\n'));

		if (range) {
			// El rango de la palabra tecleada se reemplaza por el snippet.
			item.range = range;
		}

		return item;
	}
}