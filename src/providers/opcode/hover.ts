import { CONFIG, CommandType, Singleton, getDottedWordRangeAtPosition } from '@utils';
import * as vscode from 'vscode';
import { BaseProvider } from '../base';
import { OpcodeProvider } from './opcode';

export class OpcodeHoverProvider extends Singleton {
	private opcode: OpcodeProvider = OpcodeProvider.getInstance();
	private baseProvider: BaseProvider = BaseProvider.getInstance();

	public register() {
		const provider: vscode.HoverProvider = {
			provideHover: (doc, pos, _token) => {
				const wordRange = doc.getWordRangeAtPosition(pos);
				if (!wordRange) {
					return;
				}

				const opcodes = this.opcode.get();
				const word = doc.getText(wordRange);

				const opcodeInfo = opcodes.get(word);
				if (!opcodeInfo) {
					return;
				}

				const element = opcodeInfo.find(cmd => cmd.name === word);
				if (!element) {
					return;
				}

				const format = (element.format?.[CommandType.OPCODE] ?? '');

				const warnings: string[] = [];
				if (element.attrs?.isUnsupported) {
					warnings.push('⚠️ Unsupported opcode in this GTA mode — the game ignores it.');
				}
				if (element.attrs?.isNop) {
					warnings.push('⚠️ NOP opcode (no implementation) — do not use.');
				}

				const markdown = new vscode.MarkdownString();
				markdown.appendMarkdown(`${format}\n\n${element.shortDesc}`);
				if (warnings.length > 0) {
					markdown.appendMarkdown(`\n\n${warnings.join('\n\n')}`);
				}

				return new vscode.Hover(markdown, wordRange);
			}
		};

		this.baseProvider.context.subscriptions.push(vscode.languages.registerHoverProvider(CONFIG.LANGUAGE_SELECTOR, provider));
	}
}