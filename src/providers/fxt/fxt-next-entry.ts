import { Singleton, showInfoToast } from '@utils';
import * as vscode from 'vscode';
import { LocaleManager } from '@i18n';
import { BaseProvider } from '../base';

const ENTRY_RE = /^(\s*)(~z~)?([A-Za-z0-9_]+@)(\d+)([\t ].*)?$/;

export class FxtNextEntry extends Singleton {
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	private t = (key: string, params?: Record<string, string | number>) =>
		LocaleManager.getInstance().t(key, params);

	public register() {
		this.baseProvider.context.subscriptions.push(
			vscode.commands.registerCommand('sb4.nextFxtEntry', () => this.nextEntry())
		);
	}

	private nextEntry() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const doc = editor.document;
		if (doc.languageId !== 'sannybuilder-fxt') {
			return;
		}
		const pos = editor.selection.active;

		const isEntry = (text: string): boolean =>
			ENTRY_RE.test(text) && !/^\s*\/\//.test(text);

		let baseLine = -1;
		let baseText = '';

		if (isEntry(doc.lineAt(pos.line).text)) {
			baseLine = pos.line;
			baseText = doc.lineAt(pos.line).text;
		} else {
			for (let i = pos.line - 1; i >= 0; i--) {
				const text = doc.lineAt(i).text;
				if (isEntry(text)) {
					baseLine = i;
					baseText = text;
					break;
				}
			}
		}

		if (baseLine < 0) {
			void showInfoToast(this.t('fxt.nextEntryNoEntry'));
			return;
		}

		const m = baseText.match(ENTRY_RE);
		if (!m) {
			return;
		}

		const [, indent = '', zPrefix = '', keyPrefix, suffix, rest = ''] = m;
		const nextSuffix = String(parseInt(suffix, 10) + 1).padStart(suffix.length, '0');
		// La nueva línea lleva solo el id incrementado: el texto NO se copia.
		// Se conserva el marcador `~z~` cuando el texto previo arrancaba con él,
		// listo para tipear la traducción (`B1@69 ~z~...` → `B1@70 ~z~`).
		const zMatch = rest.match(/^[\t ]*(~z~)/);
		const newText = `${indent}${zPrefix}${keyPrefix}${nextSuffix}${zMatch ? ` ${zMatch[1]}` : ''}`;
		const insertPos = new vscode.Position(baseLine + 1, 0);

		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, insertPos, newText + '\n');
		void vscode.workspace.applyEdit(edit).then((applied) => {
			if (!applied) {
				return;
			}
			const newLine = baseLine + 1;
			const col = Math.min(newText.length, doc.lineAt(newLine).text.length);
			const p = new vscode.Position(newLine, col);
			editor.selection = new vscode.Selection(p, p);
			editor.revealRange(new vscode.Range(newLine, 0, newLine, 0));
		});
	}
}