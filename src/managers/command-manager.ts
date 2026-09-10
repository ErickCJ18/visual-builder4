import { Command, readJsonFile, Singleton } from '@utils';
import { GtaVersionManager } from './gta-version-manager';

export class CommandManager extends Singleton {
	private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
	private commands: Map<string, Command> = new Map();

	public async init() {
		await this.load();
	}

	public getCommands() {
		return this.commands;
	}

	public async reload() {
		await this.load();
	}

	private async load() {
		const path = this.gtaVersionManager.getPath();

		if (!path) {
			return;
		}

		const content = await readJsonFile(path);

		await this.parse(content);
	}

	private async parse(content: any) {
		this.commands.clear();

		for (const extension of content.extensions) {
			for (const command of extension.commands) {
				const data = this.build(command);

				this.commands.set(data.id, data.command);
			}
		}
	}

	private build(rawCommand: any): { id: string, command: Command } {
		const command: Command = {
			id: rawCommand.id,
			name: rawCommand.name.toLowerCase(),
			class: rawCommand.class,
			member: rawCommand.member,
			input: rawCommand.input,
			output: rawCommand.output,
			shortDesc: rawCommand.short_desc,
			attrs: {
				isUnsupported: rawCommand.attrs?.is_unsupported === true,
				isKeyWord: rawCommand.attrs?.is_keyword === true
			}
		};

		return { id: rawCommand.id, command: command };
	}
}