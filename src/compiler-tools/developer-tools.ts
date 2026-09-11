import { isFileExists, Singleton, StorageKey } from '@utils';
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GtaVersionManager, StorageDataManager } from '@managers';
import { LocaleManager } from '@i18n';
import { hideSplashVideos, restoreSplashVideos } from './game-splash-guard';

const GAME_EXES: Array<{ prefix: string; exe: string }> = [
    { prefix: 'sa', exe: 'gta_sa' },
    { prefix: 'vc', exe: 'gta-vc' },
    { prefix: 'gta3', exe: 'gta3' },
];

const MAX_ERROR_LINES = 30;

export class DeveloperTools extends Singleton {
    private storageDataManager: StorageDataManager = StorageDataManager.getInstance();
    private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
    private t = (key: string, params?: Record<string, string>) => LocaleManager.getInstance().t(key, params);

    public init(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.commands.registerCommand('sb4.buildVsix', () => this.buildVsix(context)),
            vscode.commands.registerCommand('sb4.openGame', () => this.openGame()),
        );
    }

    private async buildVsix(context: vscode.ExtensionContext): Promise<void> {
        const root = context.extensionUri.fsPath;

        const tscPath = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
        if (!await isFileExists(tscPath)) {
            await vscode.window.showErrorMessage(this.t('dt.buildNeedDevDeps'));
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.t('dt.progressTitle'),
        }, async () => {
            const { code, output } = await this.runShell('npm run compile && vsce package', root);

            if (code === 0) {
                const vsix = await this.findLatestVsix(root);

                if (vsix) {
                    vscode.window.showInformationMessage(this.t('dt.vsixGenerated', { file: vsix }));
                } else {
                    vscode.window.showInformationMessage(this.t('dt.compiledNoVsix'));
                }
                return;
            }

            const tail = output.split(/\r?\n/).slice(-MAX_ERROR_LINES).join('\n');
            vscode.window.showErrorMessage(this.t('dt.buildError', { code: String(code), details: tail }));
        });
    }

    private async findLatestVsix(root: string): Promise<string | undefined> {
        let latest: string | undefined;

        for (const file of await fsp.readdir(root)) {
            if (!file.endsWith('.vsix')) {
                continue;
            }

            if (!latest) {
                latest = file;
                continue;
            }

            const a = (await fsp.stat(path.join(root, file))).mtimeMs;
            const b = (await fsp.stat(path.join(root, latest))).mtimeMs;

            if (a > b) {
                latest = file;
            }
        }

        return latest;
    }

    private async openGame(): Promise<void> {
        const folderPath = this.storageDataManager.get(StorageKey.Sb4FolderPath) as string | undefined;
        const identifier = this.gtaVersionManager.getIdentifier();

        if (!folderPath) {
            vscode.window.showErrorMessage(this.t('dt.noFolder'));
            return;
        }

        const gamePath = await this.resolveGamePath(folderPath, identifier);

        if (!gamePath) {
            vscode.window.showErrorMessage(this.t('dt.noGamePath'));
            return;
        }

        const exe = this.resolveExeName(identifier ?? '');
        const exePath = path.join(gamePath, `${exe}.exe`);

        if (!await isFileExists(exePath)) {
            vscode.window.showErrorMessage(this.t('dt.noExe', { path: exePath }));
            return;
        }

        const quickLoad = vscode.workspace.getConfiguration('sb4').get<boolean>('openGame.quickLoad', true);
        const isSanAndreas = (identifier ?? '').toLowerCase().startsWith('sa');

        if (quickLoad && isSanAndreas) {
            await hideSplashVideos(gamePath);

            const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
            child.unref();
            child.on('close', () => void restoreSplashVideos(gamePath));

            vscode.window.showInformationMessage(this.t('dt.launching', { exe }));
            return;
        }

        spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
        vscode.window.showInformationMessage(this.t('dt.launching', { exe }));
    }

    private resolveExeName(identifier: string): string {
        const match = GAME_EXES.find(item => identifier.startsWith(item.prefix) || item.prefix.startsWith(identifier));

        return match ? match.exe : 'gta_sa';
    }

    private async resolveGamePath(folderPath: string, identifier: string | undefined): Promise<string | undefined> {
        const settingsPath = path.join(folderPath, 'data', 'settings.ini');

        if (!await isFileExists(settingsPath)) {
            return undefined;
        }

        const content = await fsp.readFile(settingsPath, 'utf-8');
        const sections = this.parseSettingsIni(content);
        const id = (identifier ?? '').toLowerCase();

        for (const [name, gamePath] of sections) {
            if (name === id) {
                return gamePath;
            }
        }

        for (const [name, gamePath] of sections) {
            if (name.startsWith(id) || id.startsWith(name)) {
                return gamePath;
            }
        }

        const match = content.match(/^GamePath\s*=\s*(.+)$/m);

        return match ? match[1].trim() : undefined;
    }

    private parseSettingsIni(content: string): Map<string, string> {
        const result = new Map<string, string>();
        let currentSection = '';

        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();

            if (!line || line[0] === ';') {
                continue;
            }

            const sectionMatch = line.match(/^\[([^\]]+)\]/);

            if (sectionMatch) {
                currentSection = sectionMatch[1].toLowerCase();
                continue;
            }

            const keyMatch = line.match(/^GamePath\s*=\s*(.+)$/i);

            if (keyMatch && currentSection) {
                result.set(currentSection, keyMatch[1].trim());
            }
        }

        return result;
    }

    private runShell(command: string, cwd: string): Promise<{ code: number; output: string }> {
        return new Promise(resolve => {
            const child = spawn(command, {
                cwd,
                shell: true,
                windowsHide: true,
            });
            let output = '';

            child.stdout?.on('data', (data: Buffer) => {
                output += data.toString();
            });
            child.stderr?.on('data', (data: Buffer) => {
                output += data.toString();
            });
            child.on('error', error => resolve({ code: -1, output: error.message }));
            child.on('close', code => resolve({ code: code ?? -1, output }));
        });
    }
}