import * as vscode from 'vscode';
import { LocaleManager } from '@i18n';

const PRESET_COLORS: { name: string; hex: string }[] = [
	{ name: 'cp.c.black', hex: '#000000' }, { name: 'cp.c.darkGray', hex: '#6A6A6A' }, { name: 'cp.c.silver', hex: '#C0C0C0' }, { name: 'cp.c.white', hex: '#FFFFFF' },
	{ name: 'cp.c.red', hex: '#E06C75' }, { name: 'cp.c.orange', hex: '#D19A66' }, { name: 'cp.c.yellow', hex: '#E5C07B' }, { name: 'cp.c.gold', hex: '#FFFF00' },
	{ name: 'cp.c.green', hex: '#98C379' }, { name: 'cp.c.darkGreen', hex: '#6A9955' }, { name: 'cp.c.mint', hex: '#B8D7A3' }, { name: 'cp.c.teal', hex: '#008080' },
	{ name: 'cp.c.cyan', hex: '#56B6C2' }, { name: 'cp.c.blue', hex: '#61AFEF' }, { name: 'cp.c.lightBlue', hex: '#98CFE6' }, { name: 'cp.c.darkBlue', hex: '#528BFF' },
	{ name: 'cp.c.violet', hex: '#C678DD' }, { name: 'cp.c.purple', hex: '#AB76A6' }, { name: 'cp.c.magenta', hex: '#FF00FF' }, { name: 'cp.c.brown', hex: '#A0522D' }
];

function toHex(n: number): string {
	return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function hexToRgb(hex?: string): { r: number; g: number; b: number } {
	const value = hex?.trim().replace(/^#/, '') ?? '';

	if (/^[0-9a-fA-F]{6}$/.test(value)) {
		return {
			r: parseInt(value.slice(0, 2), 16),
			g: parseInt(value.slice(2, 4), 16),
			b: parseInt(value.slice(4, 6), 16)
		};
	}

	return { r: 128, g: 128, b: 128 };
}

/**
 * Selector de color RGB en un panel Webview (presets + sliders R/G/B + preview).
 * Devuelve el hex elegido (#rrggbb) o undefined si se cancela.
 */
export async function pickRgbColor(title: string, initialHex?: string): Promise<string | undefined> {
	const initial = hexToRgb(initialHex);

	return new Promise<string | undefined>(resolve => {
		const panel = vscode.window.createWebviewPanel(
			'sb4ColorPicker',
			title,
			vscode.ViewColumn.Active,
			{ enableScripts: true }
		);

		let settled = false;

		const finish = (hex: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(hex);
			panel.dispose();
		};

		panel.onDidDispose(() => finish(undefined));

		panel.webview.onDidReceiveMessage(message => {
			if (message.command === 'accept') {
				finish(message.hex);
			} else if (message.command === 'cancel') {
				finish(undefined);
			}
		});

		panel.webview.html = getHtml(title, initial);
	});
}

function getHtml(title: string, initial: { r: number; g: number; b: number }): string {
	const t = (key: string) => LocaleManager.getInstance().t(key);
	const presetButtons = PRESET_COLORS.map(color =>
		`<button class="swatch" title="${t(color.name)}" data-hex="${color.hex}" style="background: ${color.hex}"></button>`
	).join('\n');

	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
	<style>
		body { background: #1e1e1e; color: #cccccc; font-family: sans-serif; padding: 16px; }
		h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
		.palette { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; }
		.swatch { width: 26px; height: 26px; border: 1px solid #555; border-radius: 4px; cursor: pointer; }
		.swatch:hover { outline: 2px solid #61AFEF; }
		.row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
		.row label { width: 20px; }
		.row input[type="range"] { flex: 1; }
		.row input[type="number"] { width: 56px; background: #252526; color: #cccccc; border: 1px solid #3c3c3c; padding: 3px 6px; }
		.row input[type="text"] { width: 96px; background: #252526; color: #cccccc; border: 1px solid #3c3c3c; padding: 5px 8px; }
		.preview { display: flex; align-items: center; gap: 12px; margin: 14px 0 18px; }
		.preview-box { width: 72px; height: 40px; border: 1px solid #555; border-radius: 4px; }
		.buttons { display: flex; justify-content: flex-end; gap: 8px; }
		button.btn { background: #0e639c; color: #ffffff; border: none; padding: 6px 14px; cursor: pointer; border-radius: 4px; }
		button.btn:hover { background: #1177bb; }
		button.btn.secondary { background: #3a3d41; }
		button.btn.secondary:hover { background: #45494e; }
	</style>
</head>
<body>
	<h2>${title}</h2>
	<div class="palette">${presetButtons}</div>
	<div class="row"><label>R</label><input type="range" id="r" min="0" max="255" value="${initial.r}"><input type="number" id="rNum" min="0" max="255" value="${initial.r}"></div>
	<div class="row"><label>G</label><input type="range" id="g" min="0" max="255" value="${initial.g}"><input type="number" id="gNum" min="0" max="255" value="${initial.g}"></div>
	<div class="row"><label>B</label><input type="range" id="b" min="0" max="255" value="${initial.b}"><input type="number" id="bNum" min="0" max="255" value="${initial.b}"></div>
	<div class="row"><label></label><input type="text" id="hex" value="#${toHex(initial.r)}${toHex(initial.g)}${toHex(initial.b)}"></div>
	<div class="preview"><div class="preview-box" id="preview"></div><span id="hexLabel"></span></div>
	<div class="buttons">
		<button class="btn secondary" id="cancel">${t('cp.cancel')}</button>
		<button class="btn" id="accept">${t('cp.accept')}</button>
	</div>
	<script>
		(function () {
			const r = document.getElementById('r');
			const g = document.getElementById('g');
			const b = document.getElementById('b');
			const rNum = document.getElementById('rNum');
			const gNum = document.getElementById('gNum');
			const bNum = document.getElementById('bNum');
			const hex = document.getElementById('hex');
			const preview = document.getElementById('preview');
			const hexLabel = document.getElementById('hexLabel');

			const toHex = (n) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, '0');
			const clamp = (n) => Math.max(0, Math.min(255, Math.round(+n)));

			function update() {
				const red = clamp(r.value);
				const green = clamp(g.value);
				const blue = clamp(b.value);
				r.value = red; g.value = green; b.value = blue;
				rNum.value = red; gNum.value = green; bNum.value = blue;
				const value = '#' + toHex(red) + toHex(green) + toHex(blue);
				hex.value = value;
				preview.style.background = value;
				hexLabel.textContent = value;
			}

			function apply(hexValue, rv, gv, bv) {
				r.value = rv; g.value = gv; b.value = bv;
				update();
			}

			document.querySelectorAll('.swatch').forEach(btn => {
				btn.addEventListener('click', () => {
					const h = btn.getAttribute('data-hex');
					apply(h, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
				});
			});

			[r, g, b].forEach((slider, i) => slider.addEventListener('input', () => {
				const nums = [rNum, gNum, bNum];
				nums[i].value = slider.value;
				update();
			}));
			[rNum, gNum, bNum].forEach((num, i) => num.addEventListener('input', () => {
				const sliders = [r, g, b];
				sliders[i].value = clamp(num.value);
				update();
			}));

			hex.addEventListener('input', () => {
				let value = hex.value.trim();
				if (value.startsWith('#')) { value = value.slice(1); }
				if (/^[0-9a-fA-F]{3}$/.test(value)) {
					value = value.split('').map(c => c + c).join('');
				}
				if (/^[0-9a-fA-F]{6}$/.test(value)) {
					apply('#' + value, parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16));
				}
			});

			update();

			document.getElementById('accept').addEventListener('click', () => {
				acquireVsCodeApi().postMessage({ command: 'accept', hex: hex.value.trim() });
			});
			document.getElementById('cancel').addEventListener('click', () => {
				acquireVsCodeApi().postMessage({ command: 'cancel' });
			});
		})();
	</script>
</body>
</html>`;
}