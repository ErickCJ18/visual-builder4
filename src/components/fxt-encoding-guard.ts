import { isUtf8 } from 'buffer';
import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import * as vscode from 'vscode';
import { t } from '@i18n';
import { showInfoToast } from '@utils';

const FXT_LANGUAGE_ID = 'sannybuilder-fxt';
const REPLACEMENT_CHAR_BYTES = Buffer.from([0xEF, 0xBF, 0xBD]);
const NON_ASCII_RE = /[^\x00-\x7F]/u;

export class FxtEncodingGuard {
	private handledUris = new Set<string>();

	init(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.workspace.onDidOpenTextDocument(doc => this.check(doc))
		);
	}

	private async check(doc: vscode.TextDocument): Promise<void> {
		if (doc.languageId !== FXT_LANGUAGE_ID || doc.uri.scheme !== 'file' || doc.isUntitled) {
			return;
		}

		const uriKey = doc.uri.toString();
		if (this.handledUris.has(uriKey)) {
			return;
		}

		let buffer: Buffer;
		try {
			buffer = await fsp.readFile(doc.uri.fsPath);
		} catch {
			return;
		}

		this.handledUris.add(uriKey);

		if (buffer.includes(REPLACEMENT_CHAR_BYTES)) {
			await vscode.window.showErrorMessage(t('fxt.corrupted'));
			return;
		}

		if (!this.isTrueUtf8(buffer)) {
			return;
		}

		if (this.isAnsiConvertible(buffer)) {
			await this.convertToAnsi(doc, buffer);
		} else {
			const pick = await vscode.window.showWarningMessage(t('fxt.utf8'), t('fxt.reopenWith'));
			if (pick === t('fxt.reopenWith')) {
				await vscode.commands.executeCommand('workbench.action.reopenWithEncoding');
			}
		}
	}

	private isTrueUtf8(buffer: Buffer): boolean {
		return isUtf8(buffer) && NON_ASCII_RE.test(buffer.toString('utf8'));
	}

	private isAnsiConvertible(buffer: Buffer): boolean {
		const text = buffer.toString('utf8');
		const ansi = iconv.encode(text, 'cp1252');
		return iconv.decode(ansi, 'cp1252') === text;
	}

	private async convertToAnsi(doc: vscode.TextDocument, buffer: Buffer): Promise<void> {
		const ansi = iconv.encode(buffer.toString('utf8'), 'cp1252');
		try {
			await fsp.writeFile(doc.uri.fsPath, ansi);
			await vscode.commands.executeCommand('workbench.action.files.revert');
			await showInfoToast(t('fxt.recovered'));
		} catch {
			// si algo falla, el archivo original (UTF-8) queda intacto
		}
	}
}