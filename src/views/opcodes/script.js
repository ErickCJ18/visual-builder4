const opcodeList = document.getElementById('opcode-list');
const filterInput = document.getElementById('opcode-filter');
const noResultsMessage = document.getElementById('no-results');
const opcodeMatches = document.querySelector('.opcode-matches');
const searchDisplayType = document.getElementById('search-display-type');
const vscode = acquireVsCodeApi();

const L = window.VB4_LOCALE || {};
function t(key, params) {
	let s = L[key] || key;
	if (params) {
		s = s.replace(/\{(\w+)\}/g, (m, n) => (params[n] !== undefined ? String(params[n]) : m));
	}
	return s;
}

function applyLocale() {
	document.getElementById('ow-title').textContent = t('ow.title');
	document.getElementById('ow-choose').textContent = t('ow.chooseType');
	document.getElementById('ow-opt-opcodes').textContent = t('ow.typeOpcodes');
	document.getElementById('ow-opt-classes').textContent = t('ow.typeClasses');
	document.getElementById('ow-filter-label').textContent = t('ow.filterLabel');
	filterInput.placeholder = t('ow.filterPlaceholder');
	noResultsMessage.textContent = t('ow.noResults');
	opcodeMatches.textContent = t('ow.matches', { n: 0 });
}

applyLocale();

const MessageCommand = Object.freeze({
	UPDATE_SEARCH_TYPE: 0
});

let lastSearchText = '';
let shouldScrollToTop = true;

function filterOpcodes(searchText) {
	const items = opcodeList.querySelectorAll('.opcode-item');
	let visibleItemsCount = 0;

	items.forEach(item => {
		const text = item.textContent.toLowerCase();
		if (text.includes(searchText)) {
			item.style.display = 'block';
			visibleItemsCount++;
		} else {
			item.style.display = 'none';
		}

		item.addEventListener('contextmenu', () => {
			const textToCopy = item.textContent;
			navigator.clipboard.writeText(textToCopy);
		});
	});

	if (visibleItemsCount === 0) {
		opcodeList.style.display = 'none';
		noResultsMessage.style.display = 'block';
		opcodeMatches.style.display = 'none';
	} else {
		opcodeList.style.display = 'block';
		noResultsMessage.style.display = 'none';
		opcodeMatches.style.display = 'inline';
		opcodeMatches.textContent = t('ow.matches', { n: visibleItemsCount });
	}
}

function updateOpcodes(opcodes) {
	opcodeList.innerHTML = opcodes;
	filterOpcodes(lastSearchText);
}

function focusOnInputField() {
	const inputElement = document.getElementById('opcode-filter');
	if (inputElement) {
		inputElement.focus();
	}
}

filterInput.addEventListener('input', (event) => {
	lastSearchText = event.target.value.toLowerCase();
	filterOpcodes(lastSearchText);
});

searchDisplayType.addEventListener('change', function () {
	const type = this.value;
	shouldScrollToTop = true;
	vscode.postMessage({
		command: MessageCommand.UPDATE_SEARCH_TYPE,
		type: type
	});
});

window.addEventListener('load', () => {
	focusOnInputField();
});

window.addEventListener('message', (event) => {
	const message = event.data;
	if (message.command === 'updateOpcodes') {
		updateOpcodes(message.data);

		if (shouldScrollToTop || message.scrollToTop) {
			opcodeList.scrollTop = 0;
			shouldScrollToTop = false;
		}
	}
});