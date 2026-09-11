# Contexto - Visual Builder 4 (extensión VS Code)

> Documento de contexto VIVO: se reescribe con el estado actual en cada sesión
> (no es un changelog). Lo viejo se descarta.

## Qué es / Objetivo

Extensión VS Code para escribir scripts de **Sanny Builder 4** (GTA SA/VC/III).
Fork de sb4-vscode. Combina VS Code con el backend `sanny.exe` para compilar,
descompilar y abrir el juego, y agrega colores de sintaxis por categorías
configurables + un creador de temas con preview en vivo. **UI traducible**:
idiomas incorporados en/es + idiomas creados por el usuario vía export/import.

## Entorno y prueba

- Windows, PowerShell 5.1. Working dir: `...\visual-builder4`.
- `npm run compile` (tsc + tsc-alias) para validar cambios.
- Desarrollo con F5 (Extension Development Host); para recargar los cambios: **Developer: Reload Window**.
- Copia instalada: `C:\Users\JM\.vscode\extensions\eos-mixel.visual-builder-4-0.0.1`.
  Se sincroniza con **robocopy** (`code --install-extension` se cuelga con VS Code abierto). Suele quedar desactualizada tras cada sesión.
- sanny.exe (GUI): `Start-Process -Wait --no-splash --mode sa_sbl --compile <in> <out>` / `--decompile <bin>`.
- Datos SB4 en `E:\Sanny Builder 4`: `data\sa_sbl\sa.json` (opcodes: `id`/`name`/`class`/`member`), `data\sa_sbl\enums.txt`, `themes\*.ini`, `data\settings.ini` (tema activo del editor SB4).
- **Smoke test i18n** (hecho, 23 PASS): `C:\Users\JM\AppData\Local\Temp\opencode\sim-i18n.cjs` + stub de vscode en
  `C:\Users\JM\AppData\Local\Temp\opencode\vscode-stub\node_modules` (env `NODE_PATH=<...>\vscode-stub\node_modules`; requiere `dist/i18n/index.js`). Cubre: default en, switch a es, interpolación, catálogo fusionado, catálogos completos (es ↔ en sin faltantes/sobras), import persistido en `globalStorage/i18n/languages.json`, uso de idioma importado con fallback a en, protección de built-ins, export `{id, name, texts}`, vuelta a en.
- **Smoke test splash guard** (hecho, 20 PASS): `C:\Users\JM\AppData\Local\Temp\opencode\sim-splash.cjs`, requiere `dist/compiler-tools/game-splash-guard.js`. Cubre hide/restore de `movies\` en un dir temporal, idempotencia, no-tocar `intro.mpg`/no-vídeos, dir `movies\` ausente.
- Modo/versión de prueba: **sa_sbl** (GTA SA).

## i18n (idoneos de la interfaz)

- **Catálogos** en `src/i18n/catalog.ts`: `en` (base) y `es`. Claves por dominio: `meta.*`, `statusBar.*`, `folder.*`, `gtaVersion.*`, `colors.*`, `tc.*` (theme creator), `cp.*` (color picker), `dt.*` (developer tools), `cb.*` (compilar), `coords.*`, `ow.*` (webview opcodes). Interpolación `{param}` vía `t(key, params)`. `MessageParams` = `Record<string, string|number>`.
- **`LocaleManager`** (`src/i18n/locale-manager.ts`, Singleton, re-exportado en `src/i18n/index.ts` como `t` + clase):
  - Id activo en config global **`sb4.language`** (string, default `'en'`; NO enum porque los ids importados son arbitrarios). Sin idioma modificable el fallback es `en`.
  - `t(key, params)` → catálogo del idioma activo → fallback `en` → fallback la propia key. `getCatalog()` = `en` + sobreescrituras activas (para webviews).
  - `init(context)` se ejecuta PRIMERO en `activate()`; carga `globalStorage/i18n/languages.json` (`{ languages: { id: { name, catalog } } }`) y `assertCatalogsComplete()` (console.warn si falta una key en algún catálogo).
  - `selectLanguage()` (quick pick): idiomas incorporados (en, es) + importados, `$(check)` en el activo, separador, acciones Export/Import. `setLanguage(id)` persiste la config y notifica `onDidChange`.
  - `exportTexts()`: elige idioma → Save Dialog → guarda `{ id, name, texts }` (name = nativeName). `importTexts()`: JSON → id del campo `id` o del basename sanitizado → protege built-ins (en/es) → overwrite con warning si el id ya existe importado → stats `{valid}/{missing}` (faltantes caen a en) → prompt "Apply now".
- **package.json estático** (títulos de comandos + `configuration.title` + descripciones de settings): localizado con **`package.nls.json`** (en) y **`package.nls.es.json`** (es). Los idiomas importados NO traducen esos títulos estáticos (limitación documentada).
- **Comandos**: `sb4.selectLanguage`, `sb4.exportTexts`, `sb4.importTexts`. Config: `sb4.language` + `sb4.openGame.quickLoad` (F8 quick loading).
- **Webviews**: theme-creator y rgb-color-picker incrustan `JSON.stringify(getCatalog())` (server-side `t()` para texto estático + objeto `L` en `<script>` para runtime). `WebViewManager` inyecta `{{localeScript}}` → `window.VB4_LOCALE` en el template de opcodes (ids en `index.html` + `applyLocale()` en `script.js`; el VALUE de los `<option>` NO se traduce — es la key interna que mapea `SEARCH_TYPE`).
- Textos reemplazados en: folder-manager (drogado `CONFIG.SELECT_FOLDER_LABEL`), syntax-color-manager (colors.*), gta-version-button (statusBar.*/gtaVersion.*), theme-creator (tc.*), rgb-color-picker (cp.*, incluidos nombres de presets «cp.c.*»), opcodes-search (ow.panelTitle), developer-tools (dt.*), command-base (cb.*; `executeOptions` guardan la KEY y se traducen en tiempo de uso), coords-provider (coords.*).

## Compilar / Descompilar (F6 / F7)

- **F6 compila**: el default de extensión usa la preferencia recordada
  (`StorageKey.CompileExtPref`, key = `carpeta+basename` → extensión original) ANTES de la heurística `main → scm`.
- **F7 descompila**: sanny genera `.txt` → la extensión lo **renombra a `.sb`** (fallback: abrir `.txt` si el rename falla). Ciclo `x.cs/.csm/.scm ↔ x.sb`. Los binarios quedan visibles, sin ocultar.
- **Pestaña virtual** (`sb4-tab`, `VirtualDocumentProvider`): al compilar desde una tab sin nombre, esa tab pasa a llamarse como `path.basename(outputPath)` mostrando el fuente pre-compilación, **sin pisar el binario** en disco; recompilar desde esa pestaña funciona. Mapa uri→contenido + `onDidChange`. Lenguaje `sannybuilder`.
- GtaVersionButton integrado. **F8 (open game)** probado y con **Quick Loading** (estilo Sanny Builder): si `sb4.openGame.quickLoad` (bool, default true) y el modo es GTA SA, `hideSplashVideos()` de `src/compiler-tools/game-splash-guard.ts` renombra `movies\{Logo,GTAtitles,PlaySplash}.mpg` → `.mpg.bak` ANTES de lanzar; un listener `close` sobre el child (que se lanza `detached+unref` para no morir con VS Code) los restaura al salir el juego. Suelta/autorecuperable: si el host muere con el juego abierto, los `.bak` que queden se restauran en el `close` de la próxima sesión (hide es idempotente y no toca `intro.mpg`). Para VC/III el renombrado no se aplica.

## Colores de sintaxis

- **15 categorías**: comments, labels, variables, keywords, **keywordsFlow**, numbers, strings, models, classes, commands, directives, constants, enums, **plainText**, **symbols**.
  - `keywordsFlow` = palabras de control/estructura (if, then, else, while, end, switch, case, repeat, until, do, break, continue, for, return, **wait**…) con color aparte del keyword normal.
  - `plainText` = texto base sin relación con objetos: código numérico del opcode (`0005:`), nombres sueltos de opcodes (load_scene, create_char…), etc.
  - `symbols` = operadores de programación: `==`, `!=`, `>=`, `<=`, `=`, `<`, `>`, `+`, `-`, `*`, `/`.
- **Formato INI** (`[syntax]`): `category.color=#rrggbb` (o decimal ARGB), `category.style.{bold,italic,underline,strikethrough}=1/0`.
- `resolveCandidates()` (NO async): `sb4.colors.iniPath` configurado → `<carpeta SB4>\krauber.ini` → ejemplo incluido `syntax\sb-colors.ini`.
  `findExistingFile` usa el primero existente. `reload()` repinta decorations al toque (`onChange?.()` con guarda anti-recursión `reloading`) y re-vigila el .ini en uso (sin debounce).
- **Clasificador** (tokenizer + `classifyToken`) — reglas actuales:
  - Números y floats **siempre** con color (fix raíz: `tryPushPostfix` solo consume si hay postfijo `@`/`ifsv`; si no, `pushNumberOrFloat`).
  - `commands` colorea **SOLO métodos de clase** (`memberNames`, ej. `char.IsInAir`, `camera.Shake`). Los nombres sueltos de opcodes NO se colorean como commands.
  - Dirección al inicio de línea `^(\s*[0-9A-Fa-f]{2,4}:)` → **`plainText`** (el opcode es texto base, no comando).
  - Símbolos por regex `==|!=|>=|<=|[+\-*/<>=]` → bien `symbols`, salteando comentarios, directivas, hex, dirección, `[var…]` y **strings** (lista `symbolBlockers` = exclusiones + rangos de strings). Adjuntos a números (`-1`, `+= 1`) → rangos separados, sin conflicto.
  - `classifyToken`: keywordsFlow → keywords → members (commands) → class (classes) → enum (enums) → **fallback `plainText`** para identificadores sin clasificar.
  - `classes`: `[var X: Tipo]` (tipo) y nombres de clase reales (`char`, `camera`). `enums`: nombres + elementos de `enums.txt` (ej. `CivMale` de `PedType`).
  - `comments`: `//`, `/* */`, `{...}` (no `{$`); `directives`: `{$...}`; `labels`: `@X` / `:X`; `models`: `#X`; `variables`: `$X` / `25@`; `strings`: `"..."`/`'...'`.
  - `varDeclRe` (`/gi`): `[var nombre: Tipo]` con nombre `0@`/`$x`/identificador → nombre=variables, tipo=classes; el bloque se excluye del pasaje general.
  - `0x…` se colorea por `hexRe` y se EXCLUYE del pasaje del tokenizer (para no repintar el `0`).
  - En `case N:` el `:` queda como label (comportamiento real del tokenizer, no se "arregla").

## Temas

- **Import SB4 theme** (`sb4.importTheme`): `listThemes()` lee `[meta] name` de `<SB4>\themes\*.ini` (37 temas: Krauber, Material One Dark, VS Dark…) + ítem Browse. `convertTheme` resuelve decimal/`0x…`/`#hex`/`[variables]` (cadena máx. 8) y escribe convertido a `sb4-colors.ini` (`ensureEditableIniPath`), activándolo y refrescando al instante.
  - **Sin dependencia de SB4**: eliminados `getActiveThemePath`, `tryFollowActiveTheme`, `activeThemePaths`, config `sb4.colors.followTheme`, `StorageKey.ThemeImportSource`. No se lee `settings.ini`.
- Comandos de color: `sb4.reloadColors`, `sb4.customizeColors` (1 categoría), `sb4.customizeFontStyles` (toggles), `sb4.importTheme`, `sb4.themeCreator`.

## Theme Creator (`sb4.themeCreator`, webview)

- Tabla con las **15 categorías** × (color + B/I/U/S). Color por paleta nativa + hex textual con validación; toggles; `↺` restablece la fila a sus defaults.
- **Preview en vivo** arriba: `SAMPLE_CODE` fiel al clasificador real — los tokens están verificados contra `sa.json`/`enums.txt` (solo `commands` = miembros como `IsInAir`, `classes` = `char`, `enums` = `CivMale`; el código de opcode va `plainText`, los operadores `symbols`, `wait/if/then/switch/case/end` `keywordsFlow`).
- **Guardar** → aplica al tema activo y confirma con el nombre del archivo. **Crear tema nuevo…** → pide nombre y guarda en `<SB4>\themes\<nombre>.ini` (o Save As) dejándolo activo. Live-apply con debounce 200 ms.
- Mensajes webview: `ready` / `state` / `apply` / `saveAs` / `status`. Manager: `getAllStyles`, `getDefaultStyle`, `applyTheme`, `saveThemeAs`, `getActiveThemeFileName`, `buildThemeContent`.

## Comandos registrados (extension.ts)

`sb4.selectVersion`, `sb4.selectLanguage`, `sb4.exportTexts`, `sb4.importTexts`, `sb4.openGame` (F8), `sb4.buildVsix` (F9), `sb4.reloadColors`, `sb4.customizeColors`, `sb4.customizeFontStyles`, `sb4.importTheme`, `sb4.themeCreator`, `sb4.insertCoordinates`, `sb4.insertAngle` (títulos/descripciones en package.nls.json/es). Providers: SyntaxColoring, JumpInclude, LoopWaitDiagnostics, Coords, Enum/Class/Opcode/Model/Base, DefinitionSearch, ReferenceSearch, OpcodesSearch. `activate()`: `LocaleManager.init` ANTES que cualquier otro manager.

## Archivos clave

- `src/i18n/catalog.ts` (catálogos en/es + `CATALOGS`/`CATALOG_INFO`/`DEFAULT_LANGUAGE`), `src/i18n/locale-manager.ts` (LocaleManager), `src/i18n/index.ts` (re-export `t`, `LocaleManager`, tipos). Alias `@i18n` en tsconfig.
- `src/lexer/tokenizer.ts`, `src/lexer/token-kind.ts` — tokens (Number/Float/String/LocalVar/GlobalVar/LabelJump/LabelDefine/Model/ArraySize…).
- `src/providers/syntax/syntax-coloring-provider.ts` — analyze()+classifyToken+decorations; `KEYWORDS`; `memberNames`/`className`/`enumNames`.
- `src/managers/syntax-color-manager.ts` — esquema, themes, Theme Creator backend.
- `src/components/theme-creator.ts`, `rgb-color-picker.ts`, `virtual-document-provider.component.ts`, `index.ts` (alias `@components`).
- `src/managers/webview-manager.ts` — inyección `{{cssUri}}/{{jsUri}}/{{localeScript}}`; `src/views/opcodes/index.html` + `script.js` (applyLocale).
- `src/compiler-tools/command-base.ts` (+ compile-command, decompile-command, developer-tools, game-splash-guard) — F6/F7, F8 quick load, pestaña virtual, `CompileExtPref`.
- `src/utils/types.ts` (`StorageKey`), `src/extension.ts`, `package.json` + `package.nls.json`/`package.nls.es.json`, `tsconfig.json` (alias `@components/@managers/@providers/@utils/@i18n`).
- `src/managers/gta-version-manager.ts` (lee `data\<id>\mode.xml` → identificador + path del JSON).

## Pendientes / notas

- Copia instalada sincronizada con robocopy `/MIR` (eliminó `.vsixmanifest`, `main.txt`, `logo.jpg`, `LICENSE.txt` legacy; si VS Code notifica la extensión como corrupta/desinstalada, reinstalar con `code --install-extension` con VS Code cerrado).
- Working copy commit: `1509a19`.
- F8 quick load: verificar contra la versión real del juego (si ya tiene mods que reemplazan `movies\` o SilentPatch con `SkipIntroSplashes=1`, el renombrado no encuentra nada y lanza igual).
- Código: tabs, camelCase, single quotes, sin comentarios salvo que se pidan.
- El contexto documenta el ESTADO; los cambios del momento se describen brevemente y se integran, no se acumula historial.