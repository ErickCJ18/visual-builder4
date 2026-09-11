import { Singleton, isFileExists } from '@utils';
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GtaVersionManager } from '@managers';
import { LocaleManager } from '@i18n';
import { BaseProvider } from '../base';

interface CoordsGameConfig {
    exe: string;
    playerPtr: number;
    coordsMode: 'matrix' | 'inline';
    angleOffset: number;
}

const COORDS_GAMES: Record<string, CoordsGameConfig> = {
    'gta_sa': { exe: 'gta_sa', playerPtr: 0xB6F5F0, coordsMode: 'matrix', angleOffset: 0x558 },
    'gta-vc': { exe: 'gta-vc', playerPtr: 0x94AD28, coordsMode: 'inline', angleOffset: 0x378 },
    'gta3': { exe: 'gta3', playerPtr: 0x6FB1C8, coordsMode: 'inline', angleOffset: 0x378 },
};

const GAME_EXE_BY_IDENTIFIER: Array<{ prefix: string; exe: keyof typeof COORDS_GAMES }> = [
    { prefix: 'sa', exe: 'gta_sa' },
    { prefix: 'vc', exe: 'gta-vc' },
    { prefix: 'gta3', exe: 'gta3' },
];

// Script P/Invoke que lee el puntero del jugador y las coordenadas/ángulo
// desde el proceso del juego, e imprime por stdout: "X Y Z angle".
// Sin comentarios en el script: se envía tal cual a powershell.
const COORDS_PS_SCRIPT = `
param(
    [string]$ExeName,
    [string]$PlayerPtrHex,
    [string]$CoordsMode,
    [string]$AngleOffsetHex
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, UIntPtr dwSize, out IntPtr lpNumberOfBytesRead);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
"@

function Read-Dword([UInt64]$addr) {
    $buf = New-Object byte[] 4
    $read = [IntPtr]::Zero
    if ([NativeMethods]::ReadProcessMemory($handle, [IntPtr]([Int64]$addr), $buf, [UIntPtr]([UInt64]4), [ref]$read)) {
        return [BitConverter]::ToUInt32($buf, 0)
    }
    return $null
}

function Read-Float([UInt64]$addr) {
    $buf = New-Object byte[] 4
    $read = [IntPtr]::Zero
    if ([NativeMethods]::ReadProcessMemory($handle, [IntPtr]([Int64]$addr), $buf, [UIntPtr]([UInt64]4), [ref]$read)) {
        return [BitConverter]::ToSingle($buf, 0)
    }
    return $null
}

$proc = Get-Process -Name $ExeName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
    $proc = Get-Process -Name $ExeName -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $proc) {
    Write-Output "NO_PROCESS"
    exit 1
}

$handle = [NativeMethods]::OpenProcess(0x0410, $false, [uint32]$proc.Id)
if ($handle -eq [IntPtr]::Zero) {
    Write-Output "NO_ACCESS"
    exit 1
}

try {
    $ptr = [Convert]::ToUInt64($PlayerPtrHex, 16)
    $ped = Read-Dword $ptr
    if (-not $ped) {
        Write-Output "READ_FAIL"
        exit 1
    }

    $x = $null
    $y = $null
    $z = $null
    if ($CoordsMode -eq 'matrix') {
        $mx = Read-Dword ($ped + 0x14)
        if (-not $mx) {
            Write-Output "READ_FAIL"
            exit 1
        }
        $x = Read-Float ($mx + 0x30)
        $y = Read-Float ($mx + 0x34)
        $z = Read-Float ($mx + 0x38)
    } else {
        $x = Read-Float ($ped + 0x34)
        $y = Read-Float ($ped + 0x38)
        $z = Read-Float ($ped + 0x3C)
    }

    $angleOffset = [Convert]::ToUInt64($AngleOffsetHex, 16)
    $angle = Read-Float ($ped + $angleOffset)

    if ($null -eq $x -or $null -eq $y -or $null -eq $z) {
        Write-Output "READ_FAIL"
        exit 1
    }

    $ci = [System.Globalization.CultureInfo]::InvariantCulture
    $ax = $x.ToString("R", $ci)
    $ay = $y.ToString("R", $ci)
    $az = $z.ToString("R", $ci)
    $aa = if ($null -eq $angle) { "0" } else { $angle.ToString("R", $ci) }
    Write-Output "$ax $ay $az $aa"
} finally {
    [void][NativeMethods]::CloseHandle($handle)
}
`;

interface ReadCoordsResult {
    x: number;
    y: number;
    z: number;
    angle: number;
}

// Fuente C# del lector nativo. Se compila UNA sola vez en register() con
// csc.exe del .NET Framework y se lanza como proceso directo en cada pulsación
// (sin PowerShell ni Add-Type por tecla → sin delay). Misma salida/pacto que
// el script PowerShell: "X Y Z A" o NO_PROCESS / NO_ACCESS / READ_FAIL.
const COORDS_CS_SOURCE = `
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

public static class CoordsReader {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, UIntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    private static ulong ReadU32(IntPtr h, ulong addr, out bool ok) {
        byte[] b = new byte[4];
        IntPtr read = IntPtr.Zero;
        ok = ReadProcessMemory(h, new IntPtr((long)addr), b, (UIntPtr)4, out read);
        return ok ? BitConverter.ToUInt32(b, 0) : 0;
    }

    private static float ReadF32(IntPtr h, ulong addr, out bool ok) {
        byte[] b = new byte[4];
        IntPtr read = IntPtr.Zero;
        ok = ReadProcessMemory(h, new IntPtr((long)addr), b, (UIntPtr)4, out read);
        return ok ? BitConverter.ToSingle(b, 0) : 0;
    }

    public static int Main(string[] args) {
        if (args.Length < 4) {
            Console.WriteLine("READ_FAIL");
            return 1;
        }

        string exeName = args[0];
        ulong playerPtr = Convert.ToUInt64(args[1], 16);
        string mode = args[2];
        ulong angleOffset = Convert.ToUInt64(args[3], 16);

        Process chosen = null;
        Process[] procs = Process.GetProcessesByName(exeName);
        foreach (Process p in procs) {
            if (p.MainWindowHandle != IntPtr.Zero) { chosen = p; break; }
        }
        if (chosen == null && procs.Length > 0) { chosen = procs[0]; }
        if (chosen == null) {
            Console.WriteLine("NO_PROCESS");
            return 1;
        }

        IntPtr h = OpenProcess(0x0410, false, (uint)chosen.Id);
        if (h == IntPtr.Zero) {
            Console.WriteLine("NO_ACCESS");
            return 1;
        }

        bool ok;
        ulong ped = ReadU32(h, playerPtr, out ok);
        if (!ok || ped == 0) {
            CloseHandle(h);
            Console.WriteLine("READ_FAIL");
            return 1;
        }

        float x = 0;
        float y = 0;
        float z = 0;
        if (mode == "matrix") {
            ulong m = ReadU32(h, ped + 0x14, out ok);
            if (!ok || m == 0) {
                CloseHandle(h);
                Console.WriteLine("READ_FAIL");
                return 1;
            }
            x = ReadF32(h, m + 0x30, out ok);
            y = ReadF32(h, m + 0x34, out ok);
            z = ReadF32(h, m + 0x38, out ok);
        } else {
            x = ReadF32(h, ped + 0x34, out ok);
            y = ReadF32(h, ped + 0x38, out ok);
            z = ReadF32(h, ped + 0x3C, out ok);
        }

        bool aok;
        float a = ReadF32(h, ped + angleOffset, out aok);
        CloseHandle(h);

        if (!ok) {
            Console.WriteLine("READ_FAIL");
            return 1;
        }
        if (!aok) { a = 0; }

        string line = x.ToString("R", CultureInfo.InvariantCulture) + " " +
                      y.ToString("R", CultureInfo.InvariantCulture) + " " +
                      z.ToString("R", CultureInfo.InvariantCulture) + " " +
                      a.ToString("R", CultureInfo.InvariantCulture);
        Console.WriteLine(line);
        return 0;
    }
}
`;

/**
 * Inserta las coordenadas del jugador (Ctrl+Shift+C) o su ángulo Z
 * (Ctrl+Shift+E) leyendo la memoria del juego que esté corriendo.
 *
 * Soporte oficial de SB4: solo GTA SA (PC). Aquí se extiende a VC y GTA3 con
 * las direcciones conocidas de sus versiones 1.0; los punteros/offsets se
 * pueden sobreescribir desde la configuración (sb4.coords.processOverrides)
 * para cubrir otras versiones/parches.
 *
 * Mecanismo: el lector de memoria se compila una sola vez como .exe nativo
 * (csc.exe del .NET Framework) en globalStorageUri; cada pulsación lanza ese
 * exe directamente desde Node, sin PowerShell ni Add-Type por tecla → la
 * inserción es casi instantánea. Si no se encuentra csc.exe, se cae al script
 * PowerShell P/Invoke (más lento, ~1-2 s por tecla).
 */
export class CoordsProvider extends BaseProvider {

    private gtaVersionManager: GtaVersionManager = GtaVersionManager.getInstance();
    private scriptPath = '';
    private nativeExePath = '';

    public async register(): Promise<void> {
        if (!this.context) {
            return;
        }

        const coordsDir = this.context.globalStorageUri.fsPath;
        await fsp.mkdir(coordsDir, { recursive: true });

        this.scriptPath = path.join(coordsDir, 'read-coords.ps1');
        await fsp.writeFile(this.scriptPath, COORDS_PS_SCRIPT, 'utf-8');

        this.nativeExePath = await this.compileNativeReader(coordsDir);

        this.context.subscriptions.push(
            vscode.commands.registerCommand('sb4.insertCoordinates', () => this.insertCoordinates()),
            vscode.commands.registerCommand('sb4.insertAngle', () => this.insertAngle())
        );
    }

    /**
     * Compila coords-reader.cs → read-coords.exe con csc.exe del .NET
     * Framework. Devuelve '' si no hay csc.exe o falla la compilación
     * (entonces se usa el script PowerShell como fallback).
     */
    private async compileNativeReader(coordsDir: string): Promise<string> {
        const cscCandidates = [
            `${process.env.WINDIR}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`,
            `${process.env.WINDIR}\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe`,
        ];

        let cscPath = '';
        for (const candidate of cscCandidates) {
            if (await isFileExists(candidate)) {
                cscPath = candidate;
                break;
            }
        }

        if (!cscPath) {
            return '';
        }

        const csPath = path.join(coordsDir, 'coords-reader.cs');
        const exePath = path.join(coordsDir, 'read-coords.exe');

        try {
            await fsp.writeFile(csPath, COORDS_CS_SOURCE, 'utf-8');
            const compiled = await this.compileWithCsc(cscPath, csPath, exePath);
            return compiled ? exePath : '';
        } catch {
            return '';
        }
    }

    private compileWithCsc(cscPath: string, csPath: string, exePath: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            const child = spawn(cscPath, ['/nologo', '/out:' + exePath, csPath], { windowsHide: true });

            child.on('error', () => resolve(false));
            child.on('close', code => resolve(code === 0));
        });
    }

    private resolveGame(): { config: CoordsGameConfig; overridePointerHex?: string; overrideAngleHex?: string } | undefined {
        const identifier = this.gtaVersionManager.getIdentifier();
        if (!identifier) {
            return undefined;
        }

        const entry = GAME_EXE_BY_IDENTIFIER.find(item => identifier === item.prefix || identifier.startsWith(`${item.prefix}_`));
        if (!entry) {
            return undefined;
        }

        const config = COORDS_GAMES[entry.exe];

        const overrides = vscode.workspace.getConfiguration('sb4.coords').get<Record<string, { playerPointer?: string; angleOffset?: string }>>('processOverrides', {});
        const override = overrides[entry.exe];

        return {
            config,
            overridePointerHex: override?.playerPointer ?? undefined,
            overrideAngleHex: override?.angleOffset ?? undefined,
        };
    }

    private isCreateContext(editor: vscode.TextEditor): boolean {
        const document = editor.document;
        const position = editor.selection.active;
        const lineText = document.lineAt(position.line).text;
        const prefix = lineText.slice(0, position.character);

        const match = prefix.match(/\.(\w+)\s*\([^)]*$/);
        return !!match && /create/i.test(match[1]);
    }

    private async readCoords(): Promise<ReadCoordsResult | undefined> {
        const game = this.resolveGame();

        if (!game) {
            vscode.window.showErrorMessage(LocaleManager.getInstance().t('coords.noGame'));
            return undefined;
        }

        const { config } = game;
        const playerPtrHex = this.normalizeHex(game.overridePointerHex, config.playerPtr);
        const angleOffsetHex = this.normalizeHex(game.overrideAngleHex, config.angleOffset);

        try {
            const stdout = await this.runReader(config.exe, playerPtrHex, config.coordsMode, angleOffsetHex);

            if (stdout.trim() === 'NO_PROCESS') {
                vscode.window.showInformationMessage(LocaleManager.getInstance().t('coords.notFound', { exe: config.exe }));
                return undefined;
            }

            if (stdout.trim() === 'NO_ACCESS') {
                vscode.window.showErrorMessage(LocaleManager.getInstance().t('coords.couldNotOpenProcess', { exe: config.exe }));
                return undefined;
            }

            if (stdout.trim() === 'READ_FAIL') {
                vscode.window.showErrorMessage(LocaleManager.getInstance().t('coords.readFail'));
                return undefined;
            }

            const parts = stdout.trim().split(/[\s,]+/);
            const values = parts.map(p => Number.parseFloat(p));

            if (values.length < 4 || values.some(v => !Number.isFinite(v))) {
                vscode.window.showErrorMessage(LocaleManager.getInstance().t('coords.unexpectedOutput', { output: stdout.trim() }));
                return undefined;
            }

            return { x: values[0], y: values[1], z: values[2], angle: values[3] };
        } catch (err) {
            vscode.window.showErrorMessage(LocaleManager.getInstance().t('coords.runFailed', { message: (err as Error).message }));
            return undefined;
        }
    }

    /**
     * Normaliza un valor hex a base 16 sin prefijo "0x" (C# Convert.ToUInt64
     * con base 16 lo rechaza). Si no hay override, usa el default numérico.
     */
    private normalizeHex(overrideHex: string | undefined, defaultValue: number): string {
        return (overrideHex ?? '').trim().replace(/^0x/i, '') || defaultValue.toString(16);
    }

    private runReader(exeName: string, playerPtrHex: string, coordsMode: string, angleOffsetHex: string): Promise<string> {
        if (this.nativeExePath) {
            return this.runNativeReader(exeName, playerPtrHex, coordsMode, angleOffsetHex);
        }
        return this.runPowerShell(exeName, playerPtrHex, coordsMode, angleOffsetHex);
    }

    private runNativeReader(exeName: string, playerPtrHex: string, coordsMode: string, angleOffsetHex: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const child = spawn(this.nativeExePath, [exeName, playerPtrHex, coordsMode, angleOffsetHex], { windowsHide: true });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', chunk => stdout += chunk.toString());
            child.stderr.on('data', chunk => stderr += chunk.toString());

            child.on('error', err => reject(err));
            child.on('close', () => {
                if (stderr.trim()) {
                    reject(new Error(stderr.trim()));
                    return;
                }
                resolve(stdout);
            });
        });
    }

    private runPowerShell(exeName: string, playerPtrHex: string, coordsMode: string, angleOffsetHex: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const args = [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                this.scriptPath,
                '-ExeName', exeName,
                '-PlayerPtrHex', playerPtrHex,
                '-CoordsMode', coordsMode,
                '-AngleOffsetHex', angleOffsetHex,
            ];

            const child = spawn('powershell.exe', args, { windowsHide: true });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', chunk => stdout += chunk.toString());
            child.stderr.on('data', chunk => stderr += chunk.toString());

            child.on('error', err => reject(err));
            child.on('close', () => {
                if (stderr.trim()) {
                    reject(new Error(stderr.trim()));
                    return;
                }
                resolve(stdout);
            });
        });
    }

    private formatDegrees(radians: number, decimals: number): string {
        if (!Number.isFinite(radians)) {
            return '0.00';
        }
        const degrees = radians * 180 / Math.PI;
        const normalized = ((degrees % 360) + 360) % 360;
        return normalized.toFixed(decimals);
    }

    private async insertCoordinates() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const decimals = vscode.workspace.getConfiguration('sb4.coords').get<number>('coordinateDecimals', 4);
        const result = await this.readCoords();

        if (!result) {
            return;
        }

        const x = result.x.toFixed(decimals);
        const y = result.y.toFixed(decimals);
        const z = result.z.toFixed(decimals);

        const text = this.isCreateContext(editor)
            ? `${x}, ${y}, ${z}`
            : `${x} ${y} ${z}`;

        await this.insertText(editor, text);
    }

    private async insertAngle() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const decimals = vscode.workspace.getConfiguration('sb4.coords').get<number>('angleDecimals', 2);
        const result = await this.readCoords();

        if (!result) {
            return;
        }

        await this.insertText(editor, this.formatDegrees(result.angle, decimals));
    }

    private async insertText(editor: vscode.TextEditor, text: string) {
        const selection = editor.selection.active;
        const document = editor.document;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, selection, text);
        const applied = await vscode.workspace.applyEdit(edit);

        if (applied) {
            const newPosition = selection.translate(0, text.length);
            editor.selection = new vscode.Selection(newPosition, newPosition);
        }
    }
}