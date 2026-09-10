import { CommandType } from './types';

export const VAR_NOTATIONS: Record<string, string> = {
    'var_any': 'var',
    'var_global': 'global var',
    'var_local': 'local var'
};

export const SEARCH_TYPE: Record<string, CommandType> = {
    'Opcodes': CommandType.OPCODE,
    'Classes/members': CommandType.CLASS_MEMBER
};

export const CONFIG = Object.freeze({
    LANGUAGE_SELECTOR: { language: 'sannybuilder', scheme: 'file' },
    SANNY_EXE: 'sanny.exe',
    SELECT_FOLDER_LABEL: 'Select SB4 Folder'
});

export const INCLUDE_PATTERN = /\{\$INCLUDE\s+([^\}]+)\}/g;

export const DETECT_LANG_FILE_PATTERNS = [
    /\bscript_name\s+'\w+'/,
    /\bDEFINE OBJECT SANNY BUILDER/
];