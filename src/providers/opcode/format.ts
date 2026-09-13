import { Command, CommandArgs, VAR_NOTATIONS } from '@utils';

/**
 * Formatea la línea de un opcode en estilo SBL: el código (dirección) va
 * COMENTADO entre llaves (`{00A5:}`) porque en Sanny Builder 4 el nuevo
 * lenguaje usa los opcode como comentario para el motor viejo y la sentencia
 * tipada después:
 *
 *     {00A5:} int VEH_ENFORCER = create_car {modelId} #ENFORCER x y z
 */
export function buildOpcodeLine(command: Command): string {
	const address = command.id ? `{${command.id}:}` : '';
	const output = formatOutput(command.output);
	const input = (command.input ?? []).map(a => formatOpcodeArg(a)).join(' ');
	return [address, output, command.name, input].filter(Boolean).join(' ').trimEnd();
}

function formatOutput(output?: CommandArgs[]): string {
	if (!output || output.length === 0) {
		return '';
	}

	const parts = output.map(arg => {
		const varPart = arg.source ? `${VAR_NOTATIONS[arg.source] ?? arg.source} ` : '';
		const namePart = arg.name ? `${arg.name}: ` : '';
		const typePart = arg.type ?? '';
		return `[${varPart}${namePart}${typePart}]`;
	});

	return `${parts.join(', ')} =`;
}

export function formatOpcodeArg(arg: CommandArgs): string {
	return [arg.name ? `{${arg.name}}` : '', arg.type ? `[${arg.type}]` : ''].filter(Boolean).join(' ');
}