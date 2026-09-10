import { Command, Singleton } from '@utils';
import { CommandBuilder } from '../../builders/command-builder';
import { ClassCompletionProvider } from './completion';
import { ClassHoverProvider } from './hover';

export class ClassProvider extends Singleton {
	private commandBuilder: CommandBuilder = CommandBuilder.getInstance();
	private classes = new Map<string, Command[]>();

	public init() {
		this.load();

		ClassHoverProvider.getInstance().register();
		ClassCompletionProvider.getInstance().register();
	}

	public reload() {
		this.parse();
	}

	public getMember(className: string) {
		return this.classes.get(className);
	}

	public get() {
		return this.classes;
	}

	private load() {
		this.parse();
	}

	private parse() {
		this.classes = this.commandBuilder.getClassesMembers();
	}
}