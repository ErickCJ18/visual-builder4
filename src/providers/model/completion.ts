import { CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { CompletionItemKind } from 'vscode';
import { BaseProvider } from '../base';
import { ModelProvider } from './model';

/**
 * Autocompleta nombres de modelos al escribir `#` (p.ej. `#AK47`).
 * El `#` ya está en el documento: el item inserta SOLO el nombre del modelo
 * y su rango cubre el texto escrito después del `#`, de modo que `#AK` → `#AK47`.
 */
export class ModelCompletionProvider extends Singleton {
	private model: ModelProvider = ModelProvider.getInstance();
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	public register() {
		const provider: vscode.CompletionItemProvider = {
			provideCompletionItems: (document, position, _token, context) => {
				const models = this.model.getModels();
				if (models.size === 0) {
					return [];
				}

				const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
				const hashIndex = linePrefix.lastIndexOf('#');

				// Modelos solo aplican tras un `#`. Sin `#` ante el cursor se
				// delega a los otros providers (CivMale/`#` también se usa en
				// textos, pero aquí el usuario ya escribió el prefijo).
				if (hashIndex === -1) {
					return [];
				}

				const typed = linePrefix.slice(hashIndex + 1).toLowerCase();
				const range = new vscode.Range(position.line, hashIndex + 1, position.line, position.character);

				// Coincidencias por substring (case-insensitive). Se muestran
				// primero las que empiezan por lo escrito, luego las que lo
				// contienen, y al final el resto (con `#` recién tecleado).
				const startsWith: string[] = [];
				const contains: string[] = [];
				const rest: string[] = [];

				for (const model of models) {
					const matchKey = model.toLowerCase();
					if (!typed) {
						rest.push(model);
					} else if (matchKey.startsWith(typed)) {
						startsWith.push(model);
					} else if (matchKey.includes(typed)) {
						contains.push(model);
					} else {
						rest.push(model);
					}
				}

				const ordered = [...startsWith, ...contains, ...rest].slice(0, 100);

				return ordered.map(model => {
					const item = new vscode.CompletionItem(
						`#${model}`,
						CompletionItemKind.Constant
					);

					item.insertText = model;
					item.filterText = model.toLowerCase();
					item.range = range;
					item.detail = '(Model)';

					return item;
				});
			}
		};

		this.baseProvider.context.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(CONFIG.LANGUAGE_SELECTOR, provider, '#')
		);
	}
}