import { promises as fsp } from 'fs';
import * as path from 'path';

const SPLASH_NAMES = ['Logo.mpg', 'GTAtitles.mpg', 'PlaySplash.mpg'];

async function exists(filePath: string): Promise<boolean> {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function hideSplashVideos(gamePath: string): Promise<string[]> {
    const moviesDir = path.join(gamePath, 'movies');

    if (!await exists(moviesDir)) {
        return [];
    }

    const hidden: string[] = [];

    for (const name of SPLASH_NAMES) {
        const source = path.join(moviesDir, name);
        const backup = `${source}.bak`;

        if (!await exists(source) || await exists(backup)) {
            continue;
        }

        try {
            await fsp.rename(source, backup);
            hidden.push(name);
        } catch {
            continue;
        }
    }

    return hidden;
}

export async function restoreSplashVideos(gamePath: string): Promise<void> {
    const moviesDir = path.join(gamePath, 'movies');

    for (const name of SPLASH_NAMES) {
        const source = path.join(moviesDir, name);
        const backup = `${source}.bak`;

        if (!await exists(backup) || await exists(source)) {
            continue;
        }

        try {
            await fsp.rename(backup, source);
        } catch {
            continue;
        }
    }
}