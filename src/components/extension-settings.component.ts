import * as vscode from 'vscode';
import { LocaleManager } from '@i18n';
import { RecentFileAutosave } from './recent-file-autosave.component';

type SettingsCommand =
	| { command: 'ready' }
	| { command: 'setEnabled'; enabled: boolean }
	| { command: 'setMode'; mode: 'recent' | 'all' }
	| { command: 'setMaxAgeDays'; maxAgeDays: number }
	| { command: 'clearCache' };

/**
 * "VB4: Settings": webview general de configuración del comportamiento de la
 * extensión. Por ahora agrupa el panel de autoguardado/caché; se le agregan
 * más secciones cuando haga falta.
 */
export function openSettings(): void {
	const t = (key: string, params?: Record<string, string | number>) => LocaleManager.getInstance().t(key, params);
	const autosave = RecentFileAutosave.getInstance();

	const panel = vscode.window.createWebviewPanel(
		'sb4Settings',
		t('st.panelTitle'),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

	const loadConfig = (): { enabled: boolean; mode: 'recent' | 'all'; maxAgeDays: number } => {
		const cfg = vscode.workspace.getConfiguration('sb4');
		return {
			enabled: cfg.get<boolean>('autosave.enabled', true),
			mode: cfg.get<'recent' | 'all'>('autosave.mode', 'recent'),
			maxAgeDays: cfg.get<number>('autosave.maxAgeDays', 7)
		};
	};

	const sendState = () => {
		const cfg = loadConfig();
		const info = autosave.getSnapshotInfo();
		panel.webview.postMessage({
			command: 'state',
			enabled: cfg.enabled,
			mode: cfg.mode,
			maxAgeDays: cfg.maxAgeDays,
			count: info.count,
			lastFile: info.lastFile,
			lastUpdatedAt: info.lastUpdatedAt
		});
	};

	const applyConfig = async (changes: Record<string, unknown>) => {
		const cfg = vscode.workspace.getConfiguration('sb4');
		for (const [key, value] of Object.entries(changes)) {
			await cfg.update(key, value, vscode.ConfigurationTarget.Global);
		}
		sendState();
		panel.webview.postMessage({ command: 'status', ok: true });
	};

	panel.webview.onDidReceiveMessage((message: SettingsCommand) => {
		if (message.command === 'ready') {
			sendState();
		} else if (message.command === 'setEnabled') {
			void applyConfig({ 'autosave.enabled': message.enabled });
		} else if (message.command === 'setMode') {
			void applyConfig({ 'autosave.mode': message.mode });
		} else if (message.command === 'setMaxAgeDays') {
			void applyConfig({ 'autosave.maxAgeDays': message.maxAgeDays });
		} else if (message.command === 'clearCache') {
			void autosave.clearCache().then(() => {
				sendState();
				panel.webview.postMessage({ command: 'status', ok: true });
			});
		}
	});

	panel.webview.html = getHtml(t);
}

function getHtml(t: (key: string, params?: Record<string, string | number>) => string): string {
	const L = JSON.stringify(LocaleManager.getInstance().getCatalog());
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
	.section { border-top: 1px solid #333; padding-top: 12px; margin-top: 16px; }
	.section h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; color: #9d9d9d; }
	.row { display: flex; align-items: flex-start; gap: 10px; margin: 6px 0; }
	.row .label { flex: 1; }
	.row .label .name { font-size: 13px; }
	.row .label .desc { font-size: 11px; color: #9d9d9d; margin-top: 2px; }
	.toggle { position: relative; width: 30px; height: 20px; flex: none; margin-top: 2px; cursor: pointer; }
	.toggle input { opacity: 0; width: 100%; height: 100%; position: absolute; margin: 0; cursor: pointer; z-index: 2; }
	.toggle .track { position: absolute; inset: 0; background: #3a3d41; border-radius: 10px; transition: background .12s; }
	.toggle .track::after { content: attr(data-label); position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #8c8c8c; }
	.toggle input:checked + .track { background: #0e639c; }
	.toggle input:checked + .track::after { color: #ffffff; }
	.modes { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
	.modes label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 12px; }
	.modes label input { margin-top: 2px; }
	.modes .d { display: block; font-size: 11px; color: #9d9d9d; margin-top: 1px; }
	.info { margin: 10px 0; font-size: 11px; color: #9d9d9d; background: #252526; border: 1px solid #3c3c3c; border-radius: 4px; padding: 8px 10px; }
	.buttons { margin-top: 10px; }
	.btn { background: #3a3d41; color: #cccccc; border: 1px solid #3c3c3c; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12px; }
	.btn:hover { background: #45494e; }
	.btn.danger:hover { border-color: #e06c75; color: #e06c75; }
	.days { display: flex; align-items: center; gap: 8px; }
	.days input[type=number] { width: 64px; background: #252526; color: #cccccc; border: 1px solid #3c3c3c; border-radius: 4px; padding: 4px 6px; font-size: 12px; }
	.days input[type=number]:focus { outline: none; border-color: #0e639c; }
	.status { margin-top: 12px; font-size: 11px; color: #9d9d9d; }
	.status.ok { color: #6a9955; }
</style>
</head>
<body>
	<h1>${t('st.panelTitle')}</h1>
	<p class="sub">${t('st.subtitle')}</p>
	<div class="section">
		<h2>${t('st.autosaveSection')}</h2>
		<div class="row">
			<label class="toggle"><input type="checkbox" id="autosaveEnabled"><span class="track" data-label=""></span></label>
			<div class="label">
				<div class="name">${t('st.autosaveEnabled')}</div>
				<div class="desc">${t('st.autosaveEnabledDesc')}</div>
			</div>
		</div>
		<div class="row">
			<div class="label">
				<div class="name">${t('st.autosaveModeLabel')}</div>
				<div class="modes">
					<label><input type="radio" name="mode" value="recent"><span>${t('st.modeRecent')}<span class="d">${t('st.modeRecentDesc')}</span></span></label>
					<label><input type="radio" name="mode" value="all"><span>${t('st.modeAll')}<span class="d">${t('st.modeAllDesc')}</span></span></label>
				</div>
			</div>
		</div>
		<div class="row">
			<div class="label">
				<div class="name">${t('st.cleanupTitle')}</div>
				<div class="desc">${t('st.cleanupDesc')}</div>
			</div>
		</div>
		<div class="row">
			<div class="label">
				<div class="name">${t('st.retentionLabel')}</div>
				<div class="desc">${t('st.retentionDesc')}</div>
			</div>
			<div class="days"><input type="number" id="maxAgeDays" min="0" max="365" step="1" value="7"></div>
		</div>
		<div class="info" id="cacheInfo">${t('st.cacheEmpty')}</div>
		<div class="buttons"><button class="btn danger" id="clearCache">${t('st.clearCache')}</button></div>
	</div>
	<div class="status" id="status">${t('st.statusReady')}</div>
	<script>
		(function () {
			const L = ${L};
			function t(key, params) {
				let s = L[key] || key;
				if (params) { s = s.replace(/\\{(\\w+)\\}/g, (m, n) => (params[n] !== undefined ? String(params[n]) : m)); }
				return s;
			}
			const vscode = acquireVsCodeApi();
			const enabledEl = document.getElementById('autosaveEnabled');
			const infoEl = document.getElementById('cacheInfo');
			const statusEl = document.getElementById('status');
			const daysEl = document.getElementById('maxAgeDays');

			function setStatus(text, ok) {
				statusEl.textContent = text;
				statusEl.className = 'status' + (ok ? ' ok' : '');
			}

			function applyTrackLabel() {
				const track = enabledEl.nextElementSibling;
				if (track) { track.setAttribute('data-label', enabledEl.checked ? 'ON' : 'OFF'); }
			}

			function onState(msg) {
				enabledEl.checked = !!msg.enabled;
				applyTrackLabel();
				daysEl.value = String(msg.maxAgeDays != null ? msg.maxAgeDays : 7);
				const radios = Array.from(document.querySelectorAll('input[name="mode"]'));
				radios.forEach(r => { r.checked = r.value === msg.mode; });
				if (msg.lastFile) {
					infoEl.textContent = t('st.cacheInfo', { n: String(msg.count), file: msg.lastFile });
				} else {
					infoEl.textContent = t('st.cacheEmpty');
				}
				setStatus(t('st.statusReady'));
			}

			enabledEl.addEventListener('change', () => {
				applyTrackLabel();
				vscode.postMessage({ command: 'setEnabled', enabled: enabledEl.checked });
			});

			Array.from(document.querySelectorAll('input[name="mode"]')).forEach(r => r.addEventListener('change', () => {
				if (r.checked) { vscode.postMessage({ command: 'setMode', mode: r.value }); }
			}));

			daysEl.addEventListener('change', () => {
				let v = parseInt(daysEl.value, 10);
				if (Number.isNaN(v)) { v = 7; }
				v = Math.max(0, Math.min(365, v));
				daysEl.value = String(v);
				vscode.postMessage({ command: 'setMaxAgeDays', maxAgeDays: v });
			});

			document.getElementById('clearCache').addEventListener('click', () => vscode.postMessage({ command: 'clearCache' }));

			window.addEventListener('message', event => {
				const msg = event.data;
				if (msg.command === 'state') { onState(msg); }
				else if (msg.command === 'status') { setStatus(t('st.saved'), true); }
			});

			document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ command: 'ready' }));
			vscode.postMessage({ command: 'ready' });
		})();
	</script>
</body>
</html>`;
}