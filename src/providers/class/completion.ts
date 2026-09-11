import { CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { CompletionItemKind } from 'vscode';
import { BUILTIN_CLASSES, BUILTIN_CLASS_MEMBERS } from '../../builders/builtin-library';
import { BaseProvider } from '../base';
import { ClassProvider } from './class';

export class ClassCompletionProvider extends Singleton {
	private class: ClassProvider = ClassProvider.getInstance();
	private baseProvider: BaseProvider = BaseProvider.getInstance();

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

							item.detail = `(Class member) ${className}.${command.member}`;
							item.sortText = String(idx).padStart(6, '0');

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

							item.detail = `(Class member) ${className}.${member}`;
							item.sortText = String(idx).padStart(6, '0');

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