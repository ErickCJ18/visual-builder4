import { Command, Singleton } from '@utils';
import { CommandBuilder } from '../../builders/command-builder';
import { OpcodeCompletionProvider } from './completion';
import { OpcodeHoverProvider } from './hover';

export class OpcodeProvider extends Singleton {
	private commandBuilder: CommandBuilder = CommandBuilder.getInstance();
	private opcodes = new Map<string, Command[]>();

	public init() {
		this.load();

		OpcodeHoverProvider.getInstance().register();
		OpcodeCompletionProvider.getInstance().register();
	}

	public reload() {
		this.load();
	}

	public get() {
		return this.opcodes;
	}

	private load() {
		this.opcodes = this.commandBuilder.getOpcodes();
	}
}