export enum CommandType {
    OPCODE = "OPCODE",
    CLASS_MEMBER = "CLASS_MEMBER",
};

export enum MessageCommand {
    UPDATE_SEARCH_TYPE
};

export enum StorageKey {
    GtaVersion = 'gtaVersion',
    Sb4FolderPath = 'sb4FolderPath',
    CompileExtPref = 'compileExtPref',
};

export interface CommandArgs {
    name?: string;
    type?: string;
    source?: string;
}

export interface CommandIO {
    input?: string;
    output?: string;
};

export interface Command {
    id?: string;
    name: string;
    class?: string;
    member?: string;
    format?: Partial<Record<CommandType, string>>;
    input?: CommandArgs[];
    output?: CommandArgs[];
    shortDesc: string;
    attrs?: { isUnsupported?: boolean, isNop?: boolean, isKeyWord?: boolean };
};