import { CONFIG, Singleton } from '@utils';
import * as vscode from 'vscode';
import { Token } from '../../lexer/token';
import { TokenKind } from '../../lexer/token-kind';
import { Tokenizer } from '../../lexer/tokenizer';
import { BaseProvider } from '../base';

// Bloques que se cierran con 'end' y necesitan ser rastreados solo para
// saber cuándo termina un WHILE/REPEAT que los contiene (no se les exige wait).
const NESTED_END_BLOCKS = new Set(['if', 'while', 'for', 'switch', 'function']);
const REPEAT_BLOCK = 'repeat';

// Bloques que SÍ deben contener un 'wait' en su cuerpo.
const LOOP_BLOCKS = new Set(['while', 'repeat']);

const DIAGNOSTIC_SOURCE = 'SB4';
const DIAGNOSTIC_CODE = 'missing-wait-in-loop';
const DEBOUNCE_MS = 400;

interface BlockFrame {
    type: string;
    token: Token;
    sawWait: boolean;
}

/**
 * Marca con un warning cualquier bloque WHILE/REPEAT que no contenga un
 * 'wait' en su cuerpo. Un loop así puede congelar el juego al ejecutarse,
 * ya que nunca le cede tiempo al motor entre iteraciones.
 *
 * Nota: es un chequeo heurístico basado en texto, no un análisis real de
 * flujo de control -- si el 'wait' está en un camino que no siempre se
 * ejecuta (ej. dentro de un IF sin ELSE), igual se considera "cubierto".
 * Tampoco distingue comentarios de bloque (comment-block, no line-comment)
 * porque el tokenizer compartido aún no los reconoce -- un 'wait' comentado
 * así puede dar un falso negativo.
 */
export class LoopWaitDiagnostics extends Singleton {
    private baseProvider: BaseProvider = BaseProvider.getInstance();
    private collection!: vscode.DiagnosticCollection;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    public register() {
        this.collection = vscode.languages.createDiagnosticCollection('sb4-loop-wait');
        this.baseProvider.context.subscriptions.push(this.collection);

        vscode.workspace.textDocuments
            .filter(doc => doc.languageId === CONFIG.LANGUAGE_SELECTOR.language)
            .forEach(doc => this.analyze(doc));

        this.baseProvider.context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(doc => this.scheduleAnalyze(doc)),
            vscode.workspace.onDidChangeTextDocument(e => this.scheduleAnalyze(e.document)),
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.collection.delete(doc.uri);
                this.clearTimer(doc.uri.toString());
            })
        );
    }

    private scheduleAnalyze(document: vscode.TextDocument) {
        if (document.languageId !== CONFIG.LANGUAGE_SELECTOR.language) {
            return;
        }

        const key = document.uri.toString();
        this.clearTimer(key);

        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            this.analyze(document);
        }, DEBOUNCE_MS));
    }

    private clearTimer(key: string) {
        const existing = this.debounceTimers.get(key);
        if (existing) {
            clearTimeout(existing);
            this.debounceTimers.delete(key);
        }
    }

    private analyze(document: vscode.TextDocument) {
        // Se usa una instancia nueva (no getInstance()) a propósito: el
        // Tokenizer es un Singleton que acumula tokens de llamadas previas
        // en su array interno si se reutiliza la misma instancia.
        const tokens = new Tokenizer().tokenize(document.getText());
        const diagnostics: vscode.Diagnostic[] = [];
        const stack: BlockFrame[] = [];

        for (const token of tokens) {
            if (token.kind !== TokenKind.Identifier) {
                continue;
            }

            const word = token.text.toLowerCase();

            if (word === 'wait') {
                for (const frame of stack) {
                    frame.sawWait = true;
                }
                continue;
            }

            if (word === REPEAT_BLOCK || NESTED_END_BLOCKS.has(word)) {
                stack.push({ type: word, token, sawWait: false });
                continue;
            }

            if (word === 'until') {
                const top = stack[stack.length - 1];
                if (top?.type === REPEAT_BLOCK) {
                    stack.pop();
                    if (!top.sawWait) {
                        diagnostics.push(this.buildDiagnostic(top));
                    }
                }
                continue;
            }

            if (word === 'end') {
                const top = stack.pop();
                if (top && LOOP_BLOCKS.has(top.type) && !top.sawWait) {
                    diagnostics.push(this.buildDiagnostic(top));
                }
                continue;
            }
        }

        this.collection.set(document.uri, diagnostics);
    }

    private buildDiagnostic(frame: BlockFrame): vscode.Diagnostic {
        const line = Math.max(frame.token.line - 1, 0);
        const range = new vscode.Range(line, frame.token.col, line, frame.token.col + frame.token.text.length);

        const diagnostic = new vscode.Diagnostic(
            range,
            `Este bloque '${frame.type.toUpperCase()}' no contiene 'wait' en su cuerpo. Un loop sin wait puede congelar el juego.`,
            vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = DIAGNOSTIC_CODE;
        diagnostic.source = DIAGNOSTIC_SOURCE;
        return diagnostic;
    }
}
