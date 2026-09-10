import { CommandManager, HtmlFormatColorManager } from '@managers';
import { Command, CommandArgs, CommandIO, CommandType, Singleton, VAR_NOTATIONS } from '@utils';

export class CommandFormatterProvider extends Singleton {
	private commandManager: CommandManager = CommandManager.getInstance();
	private htmlFormatColorManager: HtmlFormatColorManager = HtmlFormatColorManager.getInstance();

	public init() {
		this.formatAll();
	}

	public reload() {
		this.formatAll();
	}

	private format(commandType: CommandType) {
		const commands = this.commandManager.getCommands();

		for (const id of commands.keys()) {
			const command = commands.get(id);
			if (!command) {
				continue;
			}

			if (commandType === CommandType.CLASS_MEMBER) {
				if (!command.class || !command.member) {
					continue;
				}
			}

			const io = this.formatCommandArgs(commandType, command.input, command.output);
			const formattedString = this.formatCommand(commandType, id, command, io);

			const format: Partial<Record<CommandType, string>> = { ...(command.format ?? {}) };
			format[commandType] = formattedString;

			commands.set(id, { ...command, format: format });
		}
	}

	private formatAll() {
		for (const type in CommandType) {
			this.format(type as unknown as CommandType);
		}
	}

	private formatCommand(commandType: CommandType, id: string, command: Command, commandIO: CommandIO): string {
		return commandType === CommandType.OPCODE
			? this.formatOpcodeCommand(id, command, commandIO)
			: this.formatClassCommand(command, commandIO);
	}

	private formatOpcodeCommand(id: string, command: Command, commandIO: CommandIO): string {
		const address = this.htmlFormatColorManager.getOpcodeAddress(id + ":");
		const output = commandIO.output;
		const name = this.htmlFormatColorManager.getOpcodeName(command.name);
		const input = commandIO.input;

		return `${address} ${output} ${name} ${input}`;
	}

	public formatClassCommand(command: Command, commandIO: CommandIO): string {
		const output = commandIO.output;
		const commandClass = this.htmlFormatColorManager.getOpcodeClassName(command.class);
		const commandMember = this.htmlFormatColorManager.getOpcodeName(command.member);
		const input = commandIO.input;

		return `${output} ${commandClass}.${commandMember}${input}`;
	}

	private formatCommandArgs(commandType: CommandType, input?: CommandArgs[], output?: CommandArgs[]): CommandIO {
		return commandType === CommandType.OPCODE
			? this.formatOpcodeCommandArgs(input, output)
			: this.formatClassCommandArgs(input, output);
	}

	private formatOpcodeCommandArgs(input?: CommandArgs[], output?: CommandArgs[]): CommandIO {
		return {
			input: this.formatOpcodeInputArgs(input),
			output: this.formatOpcodeOutputArgs(output)
		};
	}

	public formatClassCommandArgs(input?: CommandArgs[], output?: CommandArgs[]): CommandIO {
		return {
			input: this.formatClassInputArgs(input),
			output: this.formatClassOutputArgs(output)
		};
	}

	private formatOpcodeInputArgs(input?: CommandArgs[]): string {
		if (!input) {
			return '';
		}

		return input.map(arg => this.formatOpcodeInputArg(arg)).join(' ');
	}

	private formatClassInputArgs(input?: CommandArgs[]): string {
		if (!input) {
			return '()';
		}

		const args = input.map(arg => this.formatClassInputArg(arg)).join(', ');
		return `(${args})`;
	}

	private formatOpcodeInputArg(args: CommandArgs): string {
		const { name, type, source } = args;

		const argName = name ? this.htmlFormatColorManager.getOpcodeArgName(`{${name}}`) : '';
		const argType = type ? this.htmlFormatColorManager.getOpcodeArgType(`[${type}]`) : '';

		return [argName, argType, source].filter(Boolean).join(' ');
	}

	private formatClassInputArg(args: CommandArgs): string {
		return this.htmlFormatColorManager.getOpcodeArgName(args.name);
	}

	private formatOpcodeOutputArgs(output?: CommandArgs[]): string {
		if (!output) {
			return '';
		}

		return output.map(arg => this.formatOpcodeOutputArg(arg)).join(', ') + ' = ' || '';
	}

	private formatClassOutputArgs(output?: CommandArgs[]): string {
		if (!output) {
			return '';
		}

		return output.map(arg => this.formatClassOutputArg(arg)).join(', ') + ' = ' || '';
	}

	private formatOpcodeOutputArg(args: CommandArgs): string {
		const { name, type, source } = args;

		const argReturnVar = source ? `${this.htmlFormatColorManager.getOpcodeReturnVarType(this.getNormalizedVar(source))} ` : '';
		const argName = name ? this.htmlFormatColorManager.getOpcodeArgName(name + ': ') : '';
		const argType = type ? this.htmlFormatColorManager.getOpcodeArgType(type) : '';

		return `[${argReturnVar}${argName}${argType}]`;
	}

	private formatClassOutputArg(args: CommandArgs): string {
		const { name, type } = args;

		const argName = name ? this.htmlFormatColorManager.getOpcodeArgName(name) : '';
		const argType = type ? this.htmlFormatColorManager.getOpcodeReturnVarType(`[${type}]`) : '';

		return [argName, argType].filter(Boolean).join(' ');
	}

	private getNormalizedVar(source: string): string {
		return VAR_NOTATIONS[source] || source;
	}
}