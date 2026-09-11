export const GAME_EXES: Array<{ prefix: string; exe: string }> = [
    { prefix: 'sa', exe: 'gta_sa' },
    { prefix: 'vc', exe: 'gta-vc' },
    { prefix: 'gta3', exe: 'gta3' },
];

export function resolveExeName(identifier: string): string {
    const match = GAME_EXES.find(item => identifier.startsWith(item.prefix) || item.prefix.startsWith(identifier));

    return match ? match.exe : 'gta_sa';
}