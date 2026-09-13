import { Singleton } from '@utils';
import * as vscode from 'vscode';

interface CompileError {
    line: number;
    message: string;
}

export class CompilerTools extends Singleton {
    private readonly errorRe = /error:\s(.+):(\d+)\s(.*)/g;

    /**
     * Extrae los errores del compile.log de sanny (`error: <archivo>:<línea> <mensaje>`).
     * Devuelve línea y mensaje ya sin el prefijo de la ruta (que para fuentes
     * temporales apunta al temp y confunde al usuario).
     */
    public parseCompileErrors(errorMessage: string): CompileError[] {
        const errors: CompileError[] = [];
        for (const match of errorMessage.matchAll(this.errorRe)) {
            const line = parseInt(match[2], 10);
            const message = match[3].trim();
            if (!isNaN(line) && message.length > 0) {
                errors.push({ line, message });
            }
        }
        return errors;
    }

    /**
     * Texto legible para el toast de error: cada mensaje sin el prefijo de ruta.
     * Si no se puede parsear, devuelve el contenido crudo recortado.
     */
    public formatErrors(errorMessage: string): string {
        const errors = this.parseCompileErrors(errorMessage);
        return errors.length > 0 ? errors.map(e => e.message).join('\n') : errorMessage.trim();
    }

    public createFileLevelDiagnostics(errorMessage: string): vscode.Diagnostic[] {
        const errors = this.parseCompileErrors(errorMessage);

        if (errors.length === 0) {
            return [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), errorMessage.trim(), vscode.DiagnosticSeverity.Error)];
        }

        return errors.map(error => {
            const range = new vscode.Range(error.line, 0, error.line, Number.MAX_SAFE_INTEGER);
            return new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
        });
}
}