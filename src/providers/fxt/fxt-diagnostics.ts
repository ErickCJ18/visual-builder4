import { Singleton } from '@utils';
import * as vscode from 'vscode';
import { LocaleManager } from '@i18n';
import { BaseProvider } from '../base';

const FXT_LANGUAGE_ID = 'sannybuilder-fxt';
const MAX_ENTRY_LENGTH = 7;
const DIAGNOSTIC_SOURCE = 'SB4';
const DEBOUNCE_MS = 300;

/**
 * Detección de errores simples para archivos .fxt. Una línea de entrada solo
 * funciona si:
 * 1. La entry GXT (el id, sin el marcador `~z~` opcional) no pasa de 7
 *    caracteres.
 * 2. No hay un espacio vacío al final del texto (impide que el juego la
 *    muestre).
 */
export class FxtDiagnostics extends Singleton {
	private baseProvider: BaseProvider = BaseProvider.getInstance();
	private collection!: vscode.DiagnosticCollection;
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private t = (key: string, params?: Record<string, string | number>) =>
		LocaleManager.getInstance().t(key, params);

	public register() {
		this.collection = vscode.languages.createDiagnosticCollection('sb4-fxt');
		this.baseProvider.context.subscriptions.push(this.collection);

		vscode.workspace.textDocuments
			.filter(doc => doc.languageId === FXT_LANGUAGE_ID)
			.forEach(doc => this.analyze(doc));

		this.baseProvider.context.subscriptions.push(
			vscode.workspace.onDidOpenTextDocument(doc => this.scheduleAnalyze(doc)),
			vscode.workspace.onDidChangeTextDocument(e => this.scheduleAnalyze(e.document)),
			vscode.workspace.onDidCloseTextDocument(doc => {
				this.collection.delete(doc.uri);
				this.clearTimer(doc.uri.toString());
			})
		);
	}

	private scheduleAnalyze(document: vscode.TextDocument) {
		if (document.languageId !== FXT_LANGUAGE_ID) {
			return;
		}

		const key = document.uri.toString();
		this.clearTimer(key);

		this.debounceTimers.set(key, setTimeout(() => {
			this.debounceTimers.delete(key);
			this.analyze(document);
		}, DEBOUNCE_MS));
	}

	private clearTimer(key: string) {
		const existing = this.debounceTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(key);
		}
	}

	private analyze(document: vscode.TextDocument) {
		const diagnostics: vscode.Diagnostic[] = [];

		for (let i = 0; i < document.lineCount; i++) {
			const text = document.lineAt(i).text;

			if (/^\s*$/.test(text) || /^\s*\/\//.test(text)) {
				continue;
			}

			// 1. Longitud de la entry GXT (sin el marcador `~z~` opcional).
			const keyMatch = text.match(/^(\s*)(~z~)?(\S+)/);
			if (keyMatch) {
				const [, leading = '', zMarker = '', id] = keyMatch;
				if (id.length > MAX_ENTRY_LENGTH) {
					const start = leading.length + zMarker.length;
					const range = new vscode.Range(i, start, i, start + id.length);
					diagnostics.push(this.buildDiagnostic(
						range,
						this.t('fxt.entryTooLong', { n: String(id.length) }),
						vscode.DiagnosticSeverity.Error,
						'gxt-entry-length'
					));
				}
			}

			// 2. Espacio vacío al final de la línea.
			const spaceMatch = text.match(/[ \t]+$/);
			if (spaceMatch && spaceMatch.index !== undefined) {
				const range = new vscode.Range(i, spaceMatch.index, i, text.length);
				diagnostics.push(this.buildDiagnostic(
					range,
					this.t('fxt.trailingSpace'),
					vscode.DiagnosticSeverity.Error,
					'gxt-trailing-space'
				));
			}
		}

		this.collection.set(document.uri, diagnostics);
	}

	private buildDiagnostic(
		range: vscode.Range,
		message: string,
		severity: vscode.DiagnosticSeverity,
		code: string
	): vscode.Diagnostic {
		const diagnostic = new vscode.Diagnostic(range, message, severity);
		diagnostic.code = code;
		diagnostic.source = DIAGNOSTIC_SOURCE;
		return diagnostic;
	}
}