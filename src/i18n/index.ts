import { MessageParams } from './catalog';
import { LocaleManager } from './locale-manager';

/**
 * Acceso cómodo al texto traducido del idioma activo.
 * Uso: t('colors.chooseCategory') o t('statusBar.versionText', { version }).
 */
export function t(key: string, params?: MessageParams): string {
	return LocaleManager.getInstance().t(key, params);
}

export { LocaleManager } from './locale-manager';
export { CATALOG_INFO, CATALOGS, DEFAULT_LANGUAGE } from './catalog';
export type { LanguageInfo } from './locale-manager';
export type { MessageParams } from './catalog';