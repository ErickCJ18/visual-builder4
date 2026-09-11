import * as vscode from 'vscode';
import { SyntaxColorManager } from '../managers/syntax-color-manager';
import type { SyntaxColorStyle } from '../managers/syntax-color-manager';
import { StorageKey } from '@utils';
import { StorageDataManager } from '../managers/storage-data-manager';
import { LocaleManager } from '@i18n';
import * as path from 'path';

interface ThemeMessage {
	command: 'ready' | 'apply' | 'saveAs' | 'status';
	styles?: Record<string, SyntaxColorStyle>;
	ok?: boolean;
	file?: string;
}

const STYLE_PROPS: Array<{ prop: 'bold' | 'italic' | 'underline' | 'strikethrough'; label: string }> = [
	{ prop: 'bold', label: 'B' },
	{ prop: 'italic', label: 'I' },
	{ prop: 'underline', label: 'U' },
	{ prop: 'strikethrough', label: 'S' }
];

/**
 * Ejemplo de código SB para el pane de vista previa. Cada token indica su
 * categoría (c). Los tokens son fieles al clasificador real:
 *  - plainText: código numérico del opcode ("0005:") y nombres sueltos de
 *    opcodes (wait, load_scene, create_char...) sin categoría.
 *  - keywordsIf: if/then/else/end (condicionales).
 *  - keywordsSwitch: switch/case/default.
 *  - keywordsLoop: while/for/repeat/until/do (+break/continue/return).
 *  - keywordsBoolean: true/false.
 *  - symbols: operadores (==, +=, ...).
 *  - commands: SOLO métodos de clase (char.IsInAir).
 *  - classes/enums/models: nombres reales verificados contra
 *    sa.json/enums.txt (char, CivMale, #BMX), no inventados.
 */
const SAMPLE_CODE: Array<Array<{ t: string; c: string }>> = [
	[{ t: '// =-= VB4 SYNTAX PREVIEW =-=', c: 'comments' }],
	[{ t: '{$CLEO include}', c: 'directives' }],
	[{ t: '// courier route: 3 colored exits', c: 'comments' }],
	[{ t: ':ROUTE_START', c: 'labels' }],
	[{ t: 'wait ', c: 'plainText' }, { t: '0', c: 'numbers' }],
	[{ t: 'if', c: 'keywordsIf' }, { t: ' $SOME_FLAG', c: 'variables' }, { t: ' ==', c: 'symbols' }, { t: ' 1', c: 'numbers' }, { t: ' then', c: 'keywordsIf' }],
	[{ t: 'switch', c: 'keywordsSwitch' }, { t: ' 0@', c: 'variables' }],
	[{ t: 'case', c: 'keywordsSwitch' }, { t: ' 3', c: 'numbers' }, { t: ':', c: 'labels' }],
	[{ t: 'while', c: 'keywordsLoop' }, { t: ' true', c: 'keywordsBoolean' }],
	[{ t: 'repeat', c: 'keywordsLoop' }, { t: ' ', c: 'plainText' }, { t: 'until', c: 'keywordsLoop' }],
	[{ t: 'for', c: 'keywordsLoop' }, { t: ' 0@', c: 'variables' }, { t: ' to', c: 'keywordsLoop' }, { t: ' 10', c: 'numbers' }],
	[{ t: '0005:', c: 'plainText' }, { t: ' $COUNTER', c: 'variables' }, { t: ' +=', c: 'symbols' }, { t: ' 1', c: 'numbers' }],
	[{ t: '0861:', c: 'plainText' }, { t: ' 0@', c: 'variables' }, { t: ' += offset', c: 'symbols' }, { t: ' 1', c: 'numbers' }, { t: ' 2', c: 'numbers' }, { t: ' 3', c: 'numbers' }, { t: ' ', c: 'plainText' }, { t: '90.5', c: 'numbers' }],
	[{ t: 'load_scene ', c: 'plainText' }, { t: '"las2.img"', c: 'strings' }],
	[{ t: 'create_char ', c: 'plainText' }, { t: 'CivMale', c: 'enums' }, { t: ' #BMX', c: 'models' }],
	[{ t: '0407:', c: 'plainText' }, { t: ' char', c: 'classes' }, { t: '.', c: 'plainText' }, { t: 'IsInAir', c: 'commands' }, { t: ' $PLAYER_ACTOR', c: 'variables' }],
	[{ t: '[var', c: 'plainText' }, { t: ' handle', c: 'variables' }, { t: ': ', c: 'plainText' }, { t: 'Char', c: 'classes' }, { t: ']', c: 'plainText' }],
	[{ t: 'end', c: 'keywordsIf' }]
];

/**
 * "VB4: Theme Creator": webview con una tabla de todas las categorías
 * (color + bold/italic/underline/strikethrough) que se aplica en vivo.
 */
export function openThemeCreator(): void {
	const manager = SyntaxColorManager.getInstance();
	const t = (key: string, params?: Record<string, string>) => LocaleManager.getInstance().t(key, params);

	const panel = vscode.window.createWebviewPanel(
		'sb4ThemeCreator',
		t('tc.panelTitle'),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

	const sendState = () => {
		const categories = manager.getCategories();
		const defaults: Record<string, SyntaxColorStyle> = {};
		for (const category of categories) {
			defaults[category] = manager.getDefaultStyle(category);
		}
		panel.webview.postMessage({ command: 'state', categories, styles: manager.getAllStyles(), defaults, activeFile: manager.getActiveThemeFileName() });
	};

	panel.webview.onDidReceiveMessage((message: ThemeMessage) => {
		if (message.command === 'ready') {
			sendState();
		} else if (message.command === 'apply' && message.styles) {
			void manager.applyTheme(message.styles).then(ok => {
				panel.webview.postMessage({ command: 'status', ok, file: ok ? manager.getActiveThemeFileName() : undefined } as ThemeMessage);
			});
		} else if (message.command === 'saveAs' && message.styles) {
			void (async () => {
				const name = await vscode.window.showInputBox({
					prompt: t('tc.newThemePrompt'),
					value: t('tc.newThemeValue'),
					validateInput: value => (value && value.trim().length > 0 ? undefined : t('tc.newThemeEmpty'))
				});

				if (!name) {
					return;
				}

				const safeName = name.trim().replace(/[<>:"/\\|?*]+/g, '').replace(/\s+$/g, '').trim() || t('tc.newThemeValue');
				const folderPath = StorageDataManager.getInstance().get<string>(StorageKey.Sb4FolderPath);
				let targetPath: string | undefined;

				if (folderPath) {
					targetPath = path.join(folderPath, 'themes', `${safeName}.ini`);
				} else {
					const uri = await vscode.window.showSaveDialog({
						title: t('tc.saveDialogTitle'),
						filters: { 'INI theme': ['ini'] },
						saveLabel: t('tc.saveDialogLabel')
					});
					targetPath = uri ? uri.fsPath : undefined;
				}

				if (!targetPath) {
					return;
				}

				const ok = await manager.saveThemeAs(message.styles!, targetPath);
				panel.webview.postMessage({ command: 'status', ok, file: ok ? path.basename(targetPath) : undefined } as ThemeMessage);
			})();
		}
	});

	panel.webview.html = getHtml(STYLE_PROPS);
}

function getHtml(styleProps: typeof STYLE_PROPS): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
	:root { color-scheme: dark; }
	body { background: #1e1e1e; color: #cccccc; font-family: sans-serif; padding: 12px 16px 20px; }
	h1 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
	.sub { margin: 0 0 14px; font-size: 11px; color: #9d9d9d; }
	table { border-collapse: collapse; width: 100%; }
	th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #333; }
	th { font-size: 10px; text-transform: uppercase; color: #9d9d9d; }
	th.c, td.c { text-align: center; }
	td.cat { font-weight: 600; font-size: 13px; white-space: nowrap; }
	.color-cell { display: flex; align-items: center; gap: 8px; }
	input[type="color"] { width: 34px; height: 24px; padding: 0; border: 1px solid #3c3c3c; background: transparent; cursor: pointer; }
	input[type="color"]::-webkit-color-swatch-wrapper { padding: 1px; }
	input[type="color"]::-webkit-color-swatch { border: none; border-radius: 3px; }
	input[type="text"] { width: 74px; background: #252526; color: #cccccc; border: 1px solid #3c3c3c; padding: 4px 6px; font-size: 12px; }
	input[type="text"].bad { border-color: #e06c75; }
	.toggle { position: relative; width: 30px; height: 20px; margin: 0 auto; cursor: pointer; }
	.toggle input { opacity: 0; width: 100%; height: 100%; position: absolute; margin: 0; cursor: pointer; z-index: 2; }
	.toggle .track { position: absolute; inset: 0; background: #3a3d41; border-radius: 10px; transition: background .12s; }
	.toggle .track::after { content: attr(data-label); position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #8c8c8c; }
	.toggle input:checked + .track { background: #0e639c; }
	.toggle input:checked + .track::after { color: #ffffff; }
	.reset { background: none; border: 1px solid #3c3c3c; color: #9d9d9d; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
	.reset:hover { border-color: #e06c75; color: #e06c75; }
	.status { margin-top: 12px; font-size: 11px; color: #9d9d9d; }
	.status.saving { color: #d7ba7d; }
	.status.ok { color: #6a9955; }
	.status.err { color: #e06c75; }
.btn { background: #0e639c; color: #ffffff; border: none; padding: 7px 16px; cursor: pointer; border-radius: 4px; font-size: 12px; }
	.btn:hover { background: #1177bb; }
	.btn.secondary { background: #3a3d41; color: #cccccc; }
	.btn.secondary:hover { background: #45494e; }
	.footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; }
	.footer .buttons { display: flex; gap: 8px; }
	.preview { border: 1px solid #333; background: #1c1c1c; border-radius: 4px; margin-bottom: 16px; overflow: auto; max-height: 270px; }
	.preview .ptitle { padding: 6px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #9d9d9d; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; background: #1c1c1c; }
	.pline { white-space: pre; font-family: Consolas, 'Cascadia Code', monospace; font-size: 12.5px; line-height: 1.6; padding: 0 10px; }
	.pline .plain { color: #cccccc; }
</style>
</head>
<body>
	<h1>${LocaleManager.getInstance().t('tc.panelTitle')}</h1>
	<p class="sub" id="sub"></p>
	<div class="preview">
		<div class="ptitle"><span>${LocaleManager.getInstance().t('tc.previewTitle')}</span><span>${LocaleManager.getInstance().t('tc.previewLiveBadge')}</span></div>
		<div id="preview-code" style="padding:4px 0 10px;"></div>
	</div>
	<table>
		<thead>
			<tr>
				<th>${LocaleManager.getInstance().t('tc.colCategory')}</th><th>${LocaleManager.getInstance().t('tc.colColor')}</th>
				${styleProps.map(s => `<th class="c" title="${s.prop}">${s.label}</th>`).join('')}
				<th class="c"></th>
			</tr>
		</thead>
		<tbody id="rows"></tbody>
	</table>
	<div class="status" id="status">${LocaleManager.getInstance().t('tc.loading')}</div>
	<div class="footer">
		<div class="buttons">
			<button class="btn" id="save">${LocaleManager.getInstance().t('tc.saveBtn')}</button>
			<button class="btn secondary" id="saveAs">${LocaleManager.getInstance().t('tc.saveAsBtn')}</button>
		</div>
		<span class="sub" style="margin:0">${LocaleManager.getInstance().t('tc.footerHint')}</span>
	</div>
	<script>
		(function () {
			const L = ${JSON.stringify(LocaleManager.getInstance().getCatalog())};
			function t(key, params) {
				let s = L[key] || key;
				if (params) { s = s.replace(/\\{(\\w+)\\}/g, (m, n) => (params[n] !== undefined ? String(params[n]) : m)); }
				return s;
			}
			const vscode = acquireVsCodeApi();
			const rowsEl = document.getElementById('rows');
			const statusEl = document.getElementById('status');

			document.getElementById('sub').innerHTML = t('tc.activeSub', { file: '<strong id="activeFile">' + t('tc.unknownFile') + '</strong>' });

			const state = { categories: [], styles: {}, defaults: {} };
			let timer = null;

			const SAMPLE = ${JSON.stringify(SAMPLE_CODE)};

			function styleCss(style) {
				const parts = [];
				if (style && style.color) { parts.push('color:' + style.color); }
				if (style && style.bold) { parts.push('font-weight:700'); }
				if (style && style.italic) { parts.push('font-style:italic'); }
				const decos = [];
				if (style && style.underline) { decos.push('underline'); }
				if (style && style.strikethrough) { decos.push('line-through'); }
				if (decos.length) { parts.push('text-decoration:' + decos.join(' ')); }
				return parts.join(';');
			}

			function renderPreview() {
				const box = document.getElementById('preview-code');
				if (!box) { return; }
				box.innerHTML = '';
				SAMPLE.forEach(lineTokens => {
					const div = document.createElement('div');
					div.className = 'pline';
					lineTokens.forEach(tok => {
						const span = document.createElement('span');
						span.textContent = tok.t;
						if (tok.c) {
							const tr = rowsEl.querySelector('tr[data-cat="' + tok.c + '"]');
							span.setAttribute('style', styleCss(tr ? tr.__read() : null));
						} else {
							span.className = 'plain';
						}
						div.appendChild(span);
					});
					box.appendChild(div);
				});
			}

			function setStatus(html, cls) {
				statusEl.className = 'status' + (cls ? ' ' + cls : '');
				statusEl.innerHTML = html;
			}

			function capitalize(cat) {
				return cat.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
			}

			function buildRow(cat, style, defaults) {
				const tr = document.createElement('tr');
				tr.innerHTML =
					'<td class="cat">' + capitalize(cat) + '</td>' +
					'<td><div class="color-cell">' +
						'<input type="color" data-role="color">' +
						'<input type="text" data-role="hex" maxlength="7" spellcheck="false">' +
					'</div></td>' +
					${JSON.stringify(styleProps)}.map(p =>
						'<td class="c"><label class="toggle"><input type="checkbox" data-role="style" data-prop="' + p.prop + '"><span class="track" data-label="' + p.label + '"></span></label></td>'
					).join('') +
					'<td class="c"><button class="reset" data-role="reset" title="' + t('tc.resetTitle') + '">↺</button></td>';

				const colorInput = tr.querySelector('[data-role="color"]');
				const hexInput = tr.querySelector('[data-role="hex"]');
				const toggles = Array.from(tr.querySelectorAll('[data-role="style"]'));

				function readStyle() {
					const value = hexInput.value.trim();
					const style = { color: /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined };
					toggles.forEach(cb => { style[cb.getAttribute('data-prop')] = cb.checked; });
					return style;
				}

				function setStyle(style) {
					const value = style.color || '';
					colorInput.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
					hexInput.value = value;
					hexInput.classList.toggle('bad', !!value && !/^#[0-9a-fA-F]{6}$/.test(value));
					toggles.forEach(cb => { cb.checked = !!style[cb.getAttribute('data-prop')]; });
				}

				tr.__read = readStyle;
				tr.__set = setStyle;
				setStyle(style);

				colorInput.addEventListener('input', () => {
					hexInput.value = colorInput.value;
					scheduleApply();
				});

				hexInput.addEventListener('input', () => {
					let body = hexInput.value.trim().replace(/^#/, '');
					if (/^[0-9a-fA-F]{3}$/.test(body)) {
						body = body.split('').map(c => c + c).join('');
					}
					if (/^[0-9a-fA-F]{6}$/.test(body)) {
						colorInput.value = '#' + body;
						hexInput.classList.remove('bad');
					} else {
						hexInput.classList.toggle('bad', hexInput.value.trim().length > 0);
					}
					scheduleApply();
				});

				toggles.forEach(cb => cb.addEventListener('change', scheduleApply));

				tr.querySelector('[data-role="reset"]').addEventListener('click', () => {
					setStyle(defaults || {});
					scheduleApply();
				});

				return tr;
			}

			function collectStyles() {
				const styles = {};
				Array.from(rowsEl.children).forEach(tr => { styles[tr.getAttribute('data-cat')] = tr.__read(); });
				return styles;
			}

			function scheduleApply() {
				renderPreview();
				clearTimeout(timer);
				timer = setTimeout(() => {
					state.styles = collectStyles();
					setStatus(t('tc.savingLive'), 'saving');
					vscode.postMessage({ command: 'apply', styles: state.styles });
				}, 200);
			}

			function flushSave() {
				clearTimeout(timer);
				state.styles = collectStyles();
				setStatus(t('tc.saving'), 'saving');
				vscode.postMessage({ command: 'apply', styles: state.styles });
			}

			function createNewTheme() {
				state.styles = collectStyles();
				setStatus(t('tc.savingAs'), 'saving');
				vscode.postMessage({ command: 'saveAs', styles: state.styles });
			}

			document.getElementById('save').addEventListener('click', flushSave);
			document.getElementById('saveAs').addEventListener('click', createNewTheme);

			window.addEventListener('message', event => {
				const msg = event.data;
				if (msg.command === 'state') {
					state.categories = msg.categories || [];
					state.styles = msg.styles || {};
					state.defaults = msg.defaults || {};

					document.getElementById('activeFile').textContent = msg.activeFile || t('tc.unknownFile');

					rowsEl.innerHTML = '';
					state.categories.forEach(cat => {
						const tr = buildRow(cat, state.styles[cat] || {}, state.defaults[cat]);
						tr.setAttribute('data-cat', cat);
						rowsEl.appendChild(tr);
					});

					setStatus(t('tc.ready'), 'ok');
					renderPreview();
				} else if (msg.command === 'status') {
					if (msg.ok) {
						setStatus(t('tc.savedApplied', { file: msg.file || '' }), 'ok');
						if (msg.file) {
							document.getElementById('activeFile').textContent = msg.file;
						}
					} else {
						setStatus(t('tc.errorSaving'), 'err');
					}
				}
			});

			document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ command: 'ready' }));
			vscode.postMessage({ command: 'ready' });
		})();
	</script>
</body>
</html>`;
}