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
- **Smoke test caché de tabs virtuales** (hecho, 11 PASS): `C:\Users\JM\AppData\Local\Temp\opencode\sim-tab-restore.cjs`, requiere `dist/components/virtual-document-provider.component.js`. Cubre migración LEGACY→disco (globalState → `sb4-virtual-tabs.json` en globalStorage), hidratación de `persistedUris`, `getTarget`, reapertura SOLO de tabs no abiertas, idioma SOLO a la reabierta (no toca las del workbench), idempotencia y persistencia en disco de `setTarget`.
- **Smoke test F1 expand/ciclo** (hecho, 11 PASS): `sb4-cycle-test.js` + `sb4-expand-data.js` contra sa.json real.
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

## Toasts / avisos de la interfaz

- **Los toasts informativos se auto-ocultan** tras una duración configurable (la API de VS Code NO permite descartar una notificación programáticamente; la única vía soportada para que se cierre sola es `vscode.window.withProgress({ location: ProgressLocation.Notification })`, que de paso muestra un spinner mientras dura).
- **`showInfoToast(message, durationMs?)`** en `src/utils/utils.ts` (re-exportado por `src/utils/index.ts`):
  - Lee `sb4.toast.autoDismiss` (default `true`): si está en `false` cae a `vscode.window.showInformationMessage` clásico (toast persistente).
  - Duración = `durationMs` ?? `sb4.toast.duration` (default `3000`, rango 250–60000) vía `setTimeout`.
  - Se usa **sin `await`** (`void showInfoToast(...)`) en flujos donde el toast no debe bloquear (éxito de compile/decompile, lanzar juego, expand ocpode, coords), y con `await` donde ya se esperaba el toast original.
- **Siguen siendo toasts persistentes** (NO se tocan): todos los `showErrorMessage`, los warnings y los prompts con botones (`selectFolder`, `selectGameFolder`, `meta.applyNow` —modal con "Apply now"/"Later"—, overwrite de import de idioma).
- Sitios info convertidos (~17): command-base (éxito F6/F7), developer-tools (`dt.vsixGenerated`, `dt.compiledNoVsix`, `dt.launching` x2), gta-version-button (`alreadySelected`, `loaded`), folder-manager (`folder.selectedOk`), game-folder-manager (`gf.selectedOk`), locale-manager (`meta.languageSet`, `meta.exportSaved`, `meta.importStats`), syntax-color-manager (`colors.updatedColor`, `colors.updatedFonts`, `colors.themeImported`), coords-provider (`coords.notFound`), expand.ts opcode (`ox.noEditor`, `ox.noCode`, `ox.notFound` x2).

## Compilar / Descompilar (F6 / F7)

- **F6 compila**: el default de extensión usa la preferencia recordada
  (`StorageKey.CompileExtPref`, key = `carpeta+basename` → extensión original) ANTES de la heurística `main → scm`.
- **DEMORA DE ESCRITURA (bug raíz de "compila y nada ocurre")**: sanny.exe sale del proceso en ~30–1500ms PERO escribe `compile.log`/`.cs`/`.scm`/`.txt` hasta ~900ms DESPUÉS. El `close` del child no es fin de escritura. Fix: `waitForWrite(paths, timeout)` (poll 40ms; devuelve qué rutas llegaron a existir) en `handleProcessClose`.
- **Evaluación por EVIDENCIA (no por presencia del log)**: sanny NO siempre genera `compile.log` en éxito (a veces solo existe el `.cs/.scm`). **Velocidad (sesión actual)**: el wait heredado esperaba TODOS los paths → en éxito aguantaba hasta 10 s esperando un `compile.log` que nunca llega. Ahora `waitForCompileEvidence(logPath, outputPath, started)` corta en cuanto hay señal CONCLUSIVA: el `compile.log` manda (si aparece con texto = error+diagnósticos), y el OUTPUT **re-escrito después de `started`** (`mtime > started`, para no dejar pasar un binario viejo de una compilación previa) confirma éxito probable con una gracia de 400 ms para que un log de error tardío todavía gane. Si no aparece NADA en 10 s = `cb.noOutput`. **NUNCA** se reporta éxito por ausencia: antes, `fsp.access(logPath)` lanzaba ENOENT → `handleError` mostraba un FALSO "✅ exitosa → main.scm" y llamaba `showSuccessOutput` sin await, y el `finally` de `executeOperation` ya había borrado `temporarySourceContent` → la pestaña virtual nunca abría (solo `revealInExplorer`). Eliminado el hack ENOENT=falso éxito. El éxito SIEMPRE se `await`ea antes de resolver el child, así que la limpieza del fuente temporal ya no corre contra la pestaña virtual.
- **Ventanita del IMG: suprimida pero re-emitida como toast**: sanny muestra un diálogo "IMG" al compilar (`Compiler::ShowIMGWarning=1` en `E:\Sanny Builder 4\data\settings.ini`) que informa que `script.img` está en uso por el juego y no se puede reemplazar (si cambiaste un script externo, salí y recompila). El diálogo exige OK a mano y frenaba el flujo: antes de cada COMPILE, `suppressImgWarning(folderPath)` fuerza `Compiler::ShowIMGWarning=0` en el INI (round-trip latin1; ya está aplicado en el archivo real). El MISMO aviso lo re-emite la extensión como toast no bloqueante: `getScriptImgInUseNote()` (post-éxito) intenta abrir `script.img` del juego en `r+` (pide escritura sin truncar; candidatos `carpetaJuego\script.img` y `data\script\script.img` vía `GameFolderManager.getStoredPath()`): si el open falla por lock (code ≠ ENOENT → el juego tiene el IMG abierto sin compartir escritura) se anexa `\n⚠️ {cb.imgInUse}` al mensaje de éxito; si no hay juego configurado, el archivo no existe o abre bien → sin nota.
- **Diagnostics (fix sesión actual)**: `CompilerTools` (`src/compiler-tools/compiler-tools.ts`)
  ahora parsea **TODOS** los errores del compile.log (`parseCompileErrors`, regex
  `error: <path>:<línea> <mensaje>`) → un diagnostic por error, y `formatErrors()` da el
  texto limpio (sin el prefijo de ruta del temp) para el toast. El toast de error le
  anexa `💡 cb.hintJumpToOffset0` (en/es) cuando detecta `jump to offset 0`. Los
  diagnostics se setean sobre **la pestaña real del usuario** (`sourceUri` = `editor.document.uri`
  del compilado, hilo de `execute` → `executeOperation` → `runCompilerProcess` →
  `handleProcessClose`), NO sobre el archivo temporal que sanny compila y que se borra:
  si compilás desde una fuente física/untitled/virtual, el squiggle cae en TU código.
- **Bug corregido (fuga de temp + colgado)**: `handleProcessClose` tenía `return`
  adelantados en el camino de ERROR que saltaban `resolve()` y el unlink de
  `compile.log` → la promesa de `runCompilerProcess` nunca se resolvía (progress
  infinito, `withProgress` colgado) y el `finally` de `executeOperation` nunca corría →
  el fuente temporal `sb4-src-<pid>-<ts>.sb` quedaba tirado en `%TEMP%` (root del
  "se genera un .sb aparte"). Fix: `try/catch/finally` con `resolve()` + unlink del log
  SIEMPRE en el `finally`.
- **"A jump to offset 0 found" (0084) es REAL, no son los comentarios `//`**: el error
  apunta a la línea 1 (el banner `////`) porque es un salto hacia el OFFSET 0 del script
  (inicio de archivo). En el main del usuario lo generaba `goto @BULLMAN_C1_1` (bloque
  "ALTERNATE ROUTE -- PLAYER KILLED THE DRIVER"): ese label es el PRIMER comando de la
  misión → el target queda en offset 0 → el compilador lo marca 0084 (y graba `goto 0`
  hardcodeado en el binario → el juego reinicia si se ejecuta esa rama). sanny SIGUE
  escribiendo el output (exit 0). Diagnóstico: los `sb4-src-*.sb` duplicados en `%TEMP%`
  compilados con sanny daban el error; la descompilación del `main.scm` real mostró UN
  solo `goto 0` en la misión BULLMAN1; el caché previo (sin ese bloque) compila limpio.
  Fix del script: `goto @BULLMAN_C1_1_CHECK` (label interno de la misión) o
  `terminate_this_script`; NUNCA un `goto`/`jump` al primer label de la misión/thread
  (ese label queda "antes del primer comando").
- **"Detener la compilación" al haber ERRORES (rollback, sesión actual)**: aunque
  sanny tire error, SIGUE escribiendo el binario (exit 0) y el juego queda con el
  binario ROTO. Ahora, antes de cada COMPILE, `createCompileBackup(outputPath)` copia
  el binario de destino actual a `%TEMP%\sb4-out-<pid>-<ts>.bak`. En `handleProcessClose`,
  si el compile.log tiene errores REALES (`parseCompileErrors` → >0), `discardFailedOutput`
  espera que el mtime del output quede estable (~500ms) y pasen ≥1.5s del inicio
  (sanny escribe el output hasta ~1s después del exit; el log con el error puede llegar
  ANTES que ese write) y RESTAURA el backup → el binario roto nunca pisa la versión
  buena; el toast de error anexa `♻️ cb.rollbackNote`. Sin versión previa (primera
  compilación / copia fallida), el output roto recién escrito se ELIMINA. En éxito el
  backup se descarta (`deleteCompileBackup` en el `finally` → el nuevo binario pasa a
  ser la versión buena); en `cb.noOutput` también (nada nuevo se escribió). Validado
  end-to-end contra sanny real: 7/7 (restaurar con backup + eliminar sin backup).
- **F7 descompila**: sanny genera `.txt` → la extensión lo **renombra a `.sb`** (fallback: abrir `.txt` si el rename falla). Ciclo `x.<script> ↔ x.sb` (extensiones SB4: `.scm`, `.cs`, `.cs3`, `.cs4`, `.s`, `.cm`, `.csa`, `.csi`). Los binarios quedan visibles, sin ocultar.
- **Pestaña virtual** (`sb4-tab`, `VirtualDocumentProvider`): al compilar con éxito, la pestaña activa pasa a llamarse como `path.basename(outputPath)` mostrando el fuente que se compiló, **sin pisar el binario** en disco; vale tanto para tab sin nombre (contenido temporal) como para fuente físico (contenido leído del disco); recompilar desde esa pestaña funciona. **EDTABLE**: se registra como `FileSystemProvider` (mapa uri→texto en memoria, `writeFile` actualiza el mapa) — un esquema con solo `TextDocumentContentProvider` se abre READ-ONLY en VS Code actual. Mapa uri→contenido + `onDidChangeFile`. Lenguaje `sannybuilder`. **Restauración tras recargar el dev host** (fix del "crasheo"): al cerrar/reabrir VS Code intenta restaurar la tab `sb4-tab:/main.scm`; antes no había proveedor registrado a tiempo (`onStartupFinished` dispara DESPUÉS de restaurar) y `stat`/`readFile` tiraban `FileNotFound` → no sabía resolverla. Solución: evento de activación `onFileSystem:sb4-tab` en `package.json`, `stat`/`readFile` **tolerantes** (uri ausente = archivo vacío, sin error) y **persistencia del contenido en `globalState`** (`sb4Tab.virtualDocs`) para que la tab se restaure con su contenido real y limpia (cerrarla no pide guardado). Cierre **sin diálogo** (`closeTabSilently()`, `src/compiler-tools/command-base.ts`): una tab **untitled** o virtual sucia se limpia **VACIANDO el buffer** con un `TextEditor.edit` (borrar todo el rango) — evidencia: en tabs restored/stale (`docDirty=false` pero `tabDirty=true`) ese edit es el que baja `tab.isDirty` a `false` en el workbench — y opcionalmente undo de fallback solo si `tab.isDirty` sigue true y la tab es la activa (el `docDirty` de la API es irrelevante para el diálogo: quedó true y el cierre fue igualmente silencioso). El edit se resuelve con `visibleTextEditors` (no depende del editor activo) PERO el flip de `tab.isDirty` en el workbench **exige que la tab esté en foco** (evidencia: con `active=false` el vaciado no volteó `tabDirty` y la tab se conservó). Por eso con `forceFocus` se enfoca explícitamente si hace falta. El `workbench.action.files.revert` quedó **descartado** (evidencia: sin efecto en ambos runs, `tabDirty=true` tras ejecutarlo). GARANTÍA: si `tab.isDirty` sigue true tras limpiar, NO se cierra (se conserva la pestaña y avisa) → jamás aparece el diálogo de guardado. **SWAP TEMPRANO** (tab sin nombre): orden = **limpiar/cerrar la previa MIENTRAS está activa** (el único momento en que el vaciado voltea `tabDirty`) → cierre **fuego-y-olvido** (`fireClose`, la disposición del untitled cuesta ~2.5s) → **abrir la virtual al instante**. Al terminar la compilación no se toca nada (`temporarySourceSwapped` omite `showCompiledOutput`). Si compila falla, el código queda igual en la pestaña virtual.
- GtaVersionButton integrado. **F8 (open game)** probado y con **Quick Loading** (estilo Sanny Builder): si `sb4.openGame.quickLoad` (bool, default true) y el modo es GTA SA, `hideSplashVideos()` de `src/compiler-tools/game-splash-guard.ts` renombra `movies\{Logo,GTAtitles,PlaySplash}.mpg` → `.mpg.bak` ANTES de lanzar; un listener `close` sobre el child (que se lanza `detached+unref` para no morir con VS Code) los restaura al salir el juego. Suelta/autorecuperable: si el host muere con el juego abierto, los `.bak` que queden se restauran en el `close` de la próxima sesión (hide es idempotente y no toca `intro.mpg`). Para VC/III el renombrado no se aplica.
- **Caché de pestañas virtuales entre sesiones**: guarda contenido + destino de
  compilación por uri `sb4-tab:/<basename>` **en disco** — JSON `sb4-virtual-tabs.json`
  en `globalStorageUri` (NO en `globalState`: un main.scm de 44k líneas pesa ~1.5 MB y
  VS Code avisaba `large extension state detected` en cada carga). En `init` se intenta
  leer el archivo y, si no existe, se **migra** el estado LEGACY de `globalState`
  (`sb4Tab.virtualDocs`/`sb4Tab.virtualTargets`) y se borra (el estado global vuelve a ser
  chico). Escritura con debounce 250 ms. La pasada `restoreOpenTabs()` se hace tras el
  arranque (ventana enfocada, ~1 s — o 800 ms tras el primer foco) y **solo reabre las
  virtuales que NO están abiertas**: las que el workbench ya restauró NO se tocan (ver
  crash) ni se re-colorean (quedan en plaintext, igual que el producto original). A las
  que sí abre el pase les aplica `setTextDocumentLanguage('sannybuilder')` + coloreo e
  idempotencia. NO hay limpieza al cerrar tabs (evita que shutdown purgue el caché): una
  tab cerrada reaparece al reiniciar y se vuelve a cerrar.
- **CRASH al recargar el dev host (SIGABRT, code 134) → causa real y fix**: tras dos
  crashes (`main.log`: exthost pid 12632 a los ~1.4 s y pid 8304 a los ~2.6 s del
  arranque), el denominador común NO fue el timing sino **tocar con
  `setTextDocumentLanguage`/coloreo las tabs que el workbench está restaurando/pintando
  en el arranque**. El previo intento de "colorizar también las restauradas" lo crasheaba
  (el crash N.º 2 ocurrió AUN con el pase a ~1 s). Fix definitivo: `restoreOpenTabs`
  vuelve a **skip-if-open** (comportamiento estable de toda la noche: solo reabre y
  colorea las que faltan); `scheduleAutoRestore` corre solo con ventana enfocada a ~1 s /
  800 ms tras foco; todo en try/catch. **PENDIENTE (cosmético)**: reaplicar colores a las
  tabs restauradas por el workbench de forma SEGURA (p. ej. con un disparador tras
  `onStartupFinished` o al activar el editor por foco del usuario), sin volver a correr en
  la ventana de restore.

## Colores de sintaxis

- **Renderizado INCREMENTAL por línea** (`DEBOUNCE_MS = 16`): el documento se
  analiza línea a línea arrastrando el estado de comentarios de bloque/llaves
  (`blockIn/braceIn`) y el `.` final (`prevDot`). Cada edición de una sola
  línea re-analiza SOLO esa línea (y las siguientes si cambió la continuidad de
  un comentario, hasta que el estado se re-estabiliza); cambios estructurales
  (insertar/borrar líneas o saltos de línea) caen a análisis completo. Caché
  `paints` (Map uri→`DocPaint{lines, catRanges}`). Así el coloreo es
  instantáneo aunque el archivo tenga 44k líneas (main.scm). Las categorías
  afectadas se reconstruyen por filtrado del agregado (no se repintan todas).
- **Números NEGATIVOS** (`-1655.8176`, `-.5`): fix en el tokenizer — el bucle
  de `multiCharTokens` ya NO avanza `col` en match parcial (antes consumía el
  `-` de `-=` en `-1655...` y el signo+el `1` quedaban sin token, blancos) y se
  añadió una rama de número con signo pegada a dígito/`.dígito` (el token
  incluye el `-`). El pasaje de `symbols` bloquea el signo ya coloreado
  (`signedNumberRe`) para que no lo repinte encima como operador de resta; el
  `-` suelto (`1@ = 2@ - 3@`) SEGUE siendo symbol.
- **Clases con fallback integrado** (`src/builders/builtin-library.ts`): las 103
  clases + 2382 miembros estándar de sa.json (generados estáticamente) se
  siembran SIEMPRE en `className`/`memberNames` del coloreador y en el
  completado de clases (`ClassCompletionProvider`): si no hay carpeta/versión
  SB4 seleccionada (storage `Sb4FolderPath`), `Text`/`Char`/`Camera` se
  colorean y `Text.` / `char.` sugieren sus métodos. Los datos reales del
  juego, si se seleccionan, tienen prioridad (se fusionan por encima).
- **Completado en la pestaña virtual `sb4-tab`**: `CONFIG.LANGUAGE_SELECTOR` era
  `{ language: 'sannybuilder', scheme: 'file' }` y TODOS los providers
  (completado `Text.`, enum, opcode, hover, links) se registraban con él →
  nunca se disparaban en la tab virtual (esquema `sb4-tab` ≠ `file`). Al quitar
  `scheme`, el selector queda solo por lenguaje. Bonus: el botón de versión
  SB4 (`gta-version-button.component.ts` lo empareja con `languages.match`)
  ahora también aparece sobre la tab virtual.
- **Orden del clasificador**: `className` se chequea **ANTES** que
  `memberNames`. Razón: hay miembros llamados igual que una clase (`Text`
  ← ImGui.IMGUI_TEXT, `File`, `Restart`) y antes un `Text` suelto (uso de
  clase) caía a plainText. Un miembro solo se colorea como `commands` tras un
  `.`; suelto → plainText salvo que coincida con una clase (→ classes).
- **Variables declaradas con tipo** (`int speed`, `float 0@`, bloque
  `var ... end` con `speed: float`, `[var x: int]`): el NOMBRE se recuerda por
  documento (`declaredVars: Map<uri, Set<string>>`, minúsculas) y TODO uso
  posterior se colorea `variables` aunque sea un identificador común (gana
  sobre opcodes/clases/enums; los keywords conservan su categoría). Extracción
  con `commentFree` (comentarios //, `{ }`, `/* */` con estado entre líneas).
  Nombres numéricos (`0@`, `$v`) no entran: ya se colorean por token. En
  edición incremental, si en la línea cambiada cambia la declaración
  (`sameDeclarations` contra el texto VIEJO guardado en `paint.texts`) → se
  cae a re-análisis completo (ese nombre puede usarse en cualquier otra línea).
  Los comentarios bloque mal-visionados no declaran (test: `// int falso`).
- **`and`/`or` en condicionales**: se movieron a `KEYWORDS_IF` → `if ... and
  ... or ...` colorean `if/and/or` bajo keywordsIf (antes `and/or` caían a la
  categoría genérica keywords / se veían como plainText si el .ini no la
  distinguía).
- **Repintado de la pestaña virtual**: tras `setTextDocumentLanguage`, el
  evento de lenguaje no dispara ningún listener; `command-base` llama ahora a
  `SyntaxColoringProvider.applyToEditor(editor)` (método hecho público) para
  que el coloreo se aplique al instante.
- **Comentarios**: el opener se incluye en el rango (`/*`, `{`); heredado de la
  línea anterior se dibuja desde el inicio de la línea hasta el cierre/EOL.
- **18 categorías**: comments, labels, variables, keywords, **keywordsIf**, **keywordsSwitch**, **keywordsLoop**, **keywordsBoolean**, numbers, strings, models, classes, commands, directives, constants, enums, **plainText**, **symbols**.
  - `keywordsIf` = `if/then/else/elsif/endif/end`. `keywordsSwitch` = `switch/case/default`. `keywordsLoop` = `while/for/repeat/until/do/downto/from/to/break/continue/return`. `keywordsBoolean` = `true/false`.
  - `wait` ya NO es flow: es un nombre de opcode suelto → `plainText` como load_scene/create_char.
  - `plainText` = texto base sin relación con objetos: código numérico del opcode (`0005:`), nombres sueltos de opcodes (wait, load_scene, create_char…), etc.
  - `symbols` = operadores de programación: `==`, `!=`, `>=`, `<=`, `=`, `<`, `>`, `+`, `-`, `*`, `/`.
- **Formato INI** (`[syntax]`): `category.color=#rrggbb` (o decimal ARGB), `category.style.{bold,italic,underline,strikethrough}=1/0`.
- `resolveCandidates()` (NO async): `sb4.colors.iniPath` configurado → `<carpeta SB4>\krauber.ini` → ejemplo incluido `syntax\sb-colors.ini`.
  `findExistingFile` usa el primero existente. `reload()` repinta decorations al toque (`onChange?.()` con guarda anti-recursión `reloading`) y re-vigila el .ini en uso (sin debounce).
- **Clasificador** (tokenizer + `classifyToken`) — reglas actuales:
  - Números y floats **siempre** con color (fix raíz: `tryPushPostfix` solo consume si hay postfijo `@`/`ifsv`; si no, `pushNumberOrFloat`).
  - `commands` colorea **SOLO métodos de clase** (`memberNames`) cuando son acceso real `char.IsInAir` / `camera.Shake` (token previo `Dot`). Un miembro **suelto** (`jump`, `IsInAir`…) y los nombres de opcodes (`wait`, `goto`, `load_scene`, `create_char`…) → **`plainText`** (`opcodeNames` = `command.name` (3704) se chequea ANTES que members/class/enums; `memberNames` sin `Dot` previo → plainText). Fix wait=enum / jump/goto=commands.
  - Dirección al inicio de línea `^(\s*[0-9A-Fa-f]{2,4}:)` → **`plainText`** (el opcode es texto base, no comando).
  - Símbolos por regex `==|!=|>=|<=|[+\-*/<>=]` → bien `symbols`, salteando comentarios, directivas, hex, dirección, `[var…]`, **strings** (lista `symbolBlockers` = exclusiones + rangos de strings) y los negativos (`signedNumberRe`: el `-` de `-1` ya va dentro del token numbers). El `-` de resta suelto (`1@ = 2@ - 3@`) SÍ es symbol.
  - `classifyToken`: keywordsIf → keywordsSwitch → keywordsLoop → keywordsBoolean → keywords → **declaredVars (por documento, variables)** → opcodeNames (plainText) → **class (classes)** → members (commands solo con `Dot` previo, si no plainText) → enum (enums) → **fallback `plainText`** para identificadores sin clasificar. (Clase ANTES que miembro: evita que `Text`/`File`/`Restart`, que también son miembros de otras clases, caigan a plainText.)
  - `.` (operador de acceso, `char.IsInAir`) siempre → **`plainText`** (TokenKind.Dot); el float `90.5` no genera Dot.
  - `classes`: `[var X: Tipo]` (tipo) y nombres de clase reales (`char`, `camera`). `enums`: nombres + elementos de `enums.txt` (ej. `CivMale` de `PedType`).
  - `comments`: `//`, `/* */`, `{...}` (no `{$`); `directives`: `{$...}`; `labels`: `@X` / `:X`; `models`: `#X`; `variables`: `$X` / `25@`; `strings`: `"..."`/`'...'`.
  - `varDeclRe` (`/gi`): `[var nombre: Tipo]` con nombre `0@`/`$x`/identificador → nombre=variables, tipo=classes; el bloque se excluye del pasaje general.
  - `0x…` se colorea por `hexRe` y se EXCLUYE del pasaje del tokenizer (para no repintar el `0`).
  - En `case N:` el `:` queda como label (comportamiento real del tokenizer, no se "arregla").

## Temas

- **Import SB4 theme** (`sb4.importTheme`): `listThemes()` lee `[meta] name` de `<SB4>\themes\*.ini` (37 temas: Krauber, Material One Dark, VS Dark…) + ítem Browse. `convertTheme` resuelve decimal/`0x…`/`#hex`/`[variables]` (cadena máx. 8) y escribe convertido a `sb4-colors.ini` (`ensureEditableIniPath`), activándolo y refrescando al instante.
  - **Sin dependencia de SB4**: eliminados `getActiveThemePath`, `tryFollowActiveTheme`, `activeThemePaths`, config `sb4.colors.followTheme`, `StorageKey.ThemeImportSource`. No se lee `settings.ini`.
- Comandos de color: `sb4.reloadColors`, `sb4.customizeColors` (1 categoría), `sb4.customizeFontStyles` (toggles), `sb4.importTheme`, `sb4.themeCreator`.
- **F9 build vsix**: correr SIEMPRE desde el Extension Development Host (workspace), NO desde la extensión instalada — `vsce package` no incluye devDependencies (typescript/tsc-alias) y en la copia instalada `tsc` no existe. `buildVsix` ahora detecta la falta de `node_modules\.bin\tsc(.cmd)` y muestra el error claro `dt.buildNeedDevDeps` en vez del crasheo de npm.

## Theme Creator (`sb4.themeCreator`, webview)

- Tabla con las **18 categorías** × (color + B/I/U/S). Color por paleta nativa + hex textual con validación; toggles; `↺` restablece la fila a sus defaults. Nombres legibles vía `categoryDisplayName()` (camelSplit, ej. Keywords If / Plain Text).
- **Preview en vivo** arriba: `SAMPLE_CODE` fiel al clasificador real — los tokens están verificados contra `sa.json`/`enums.txt` (solo `commands` = miembros como `IsInAir`, `classes` = `char`, `enums` = `CivMale`; el código de opcode va `plainText`, los operadores `symbols`, `wait` `plainText`, `if/then/end` `keywordsIf`, `switch/case` `keywordsSwitch`, `while/for/until/to` `keywordsLoop`, `true` `keywordsBoolean`).
- **Guardar** → aplica al tema activo y confirma con el nombre del archivo. **Crear tema nuevo…** → pide nombre y guarda en `<SB4>\themes\<nombre>.ini` (o Save As) dejándolo activo. Live-apply con debounce 200 ms.
- Mensajes webview: `ready` / `state` / `apply` / `saveAs` / `status`. Manager: `getAllStyles`, `getDefaultStyle`, `applyTheme`, `saveThemeAs`, `getActiveThemeFileName`, `buildThemeContent`.
- **Bug corregido** (webview "Loading…" eterno): en `getHtml()` el template literal se comía los backslashes del regex del `t()` inline (`\{`/`\w`/`\}` son "identity escapes" de JS → la webview recibía `/{(w+)}/g` y `{file}` nunca se interpolaba → `getElementById('activeFile')` != null → throw → sin `state` renderizado). Fix: duplicar el backslash (`/\\{(\\w+)\\}/g`). **Regla para futuros inline scripts en template literals: duplicar backslashes de cualquier regex.** `rgb-color-picker.ts` y `src/views/opcodes/script.js` están limpios; `opcodes` usa `{{localeScript}}` inyectado desde archivo (no template literal).

## Archivos FXT (.fxt) — sesión actual

- **Soporte de lenguaje** (`sannybuilder-fxt`): registro en `package.json` como
  `contributes.languages` (extensión `.fxt`, config `fxt-language-configuration.json`,
  icono propio) + grammar `syntax/fxt.tm-language.json` (`source.fxt`): la CLAVE
  (primer token de la línea) se colorea `entity.name.class.fxt`, los tags de formato
  GXT `~z~`/`~k~`/`~h~` `constant.other.gxt-format.fxt` y los sufijos `//…`
  `comment.line.fxt`.
- **Encoding (problema raíz del mojibake)**: los `.fxt` del CLEO clásico/GXT son
  **ANSI (Windows-1252)**, pero VS Code los abría como UTF-8 por defecto → los
  acentos (bytes 0xE1/0xF3…) son UTF-8 inválido → se reemplazan por `U+FFFD` (se ve
  “ï¿½”) y, al hacer Ctrl+S, quedan GRABADOS en disco (pérdida irreversible, no hay
  forma automática de recuperar el carácter original). Fix: `configurationDefaults`
  `"[sannybuilder-fxt]": { "files.encoding": "windows1252" }` → el archivo se lee y
  escribe SIEMPRE como CP1252 (round-trip perfecto para acentos españoles). Usuarios
  de CLEO Redux (UTF-8) pueden sobreescribirlo en settings de usuario
  (`"[sannybuilder-fxt]": {"files.encoding": "utf8"}`).
- **FxtEncodingGuard** (`src/components/fxt-encoding-guard.ts`, registrado en
  `activate`): en `onDidOpenTextDocument` de un `.fxt` lee los bytes del disco y:
  (1) si hay secuencias `EF BF BD` (U+FFFD) GRABADAS en disco → `showErrorMessage(fxt.corrupted)`
  (corrupción irrecuperable: los acentos originales se perdieron al guardar; restaurar
  desde backup, NO se toca el archivo);
  (2) si el archivo es **UTF-8 válido con no-ASCII** (encoding inválido para el FXT):
  si todos sus caracteres son representables en CP1252 (`isAnsiConvertible` = round-trip
  `encode(cp1252)→decode(cp1252)` idéntico) → **lo convierte solo a Windows-1252**
  (escribe `iconv.encode(text,'cp1252')`, `workbench.action.files.revert` para recargar
  la pestaña y toast `fxt.recovered`); si NO es representable (p.ej. cirílico) → warning
  `fxt.utf8` con botón "Reopen with Encoding" (sin tocar el archivo).
  Detecta UTF-8 con `buffer.isUtf8`. Procesa UNA vez por uri (set en memoria). Validado
  con harness `sim-fxt.cjs` (17 PASS, stub de vscode): utf8→conversión a bytes cp1252 +
  toast + revert; U+FFFD→error sin modificar; cp1252/ascii→silencio; cirílico→warning sin
  tocar; dedupe por uri; archivo ausente/otro lenguaje→no-op.
- Los archivos FXT tienen capturista: en los `.fxt` también se aplica el coloreo
  declarativo de TextMate (no el tokenizer incremental de `.sb`).

## Comandos registrados (extension.ts)

`sb4.selectVersion`, `sb4.selectLanguage`, `sb4.exportTexts`, `sb4.importTexts`, `sb4.openGame` (F8), `sb4.buildVsix` (F9), `sb4.reloadColors`, `sb4.customizeColors`, `sb4.customizeFontStyles`, `sb4.importTheme`, `sb4.themeCreator`, `sb4.insertCoordinates`, `sb4.insertAngle`, `sb4.expandOpcode` (F1, títulos/descripciones en package.nls.json/es). Providers: SyntaxColoring, JumpInclude, LoopWaitDiagnostics, Coords, Enum/Class/Opcode/Model/Base, OpcodeExpand, DefinitionSearch, ReferenceSearch, OpcodesSearch. `activate()`: `LocaleManager.init` ANTES que cualquier otro manager.

## Opcodes / flujo SBL (sesión actual)

- **Formato SBL con llaves** (`src/providers/opcode/format.ts`, `buildOpcodeLine`): la línea
  queda `{00A5:} [var veh: Car] = CREATE_CAR {modelId} [int]` — el código del opcode va
  COMENTADO entre llaves (SBL usa el opcode como comentario del motor viejo + sentencia
  tipada después). `formatOpcodeArg` = `{nombre}` + `[tipo]`. Usado por el completado de
  opcodes.
- **F1 expand** (`sb4.expandOpcode`, `src/providers/opcode/expand.ts`): escribís
  `009`/`0A5`/`00A5:` y F1 lo completa al opcode más cercano (exacto → prefijo directo →
  canónico sin ceros a la izquierda). Cursor tras `{XXXX:}`. F1 repetido sobre un
  `{XXXX:}` ya expandido (cursor en CUALQUIER punto de la línea) CICLA al siguiente opcode
  de la familia (0090→0091→…) reescribiendo la línea completa, sin apilar. No toca
  `{modelId}` (placeholder) ni `{candy}` (comentario). Mensajes `ox.*`.
- **F1 ciclador validado por harness** (`sb4-cycle-test.js`, 10 PASS): tras la llave,
  dentro del número, tras `:`, al final de línea y en medio de los argumentos →
  siempre el siguiente opcode de la familia; `{modelId}`/`{candy}` sin corromper.
- **TAB rellena parámetros del opcode** (`sb4.tabFillOpcodeParam`,
  `src/providers/opcode/tab-fill.ts`, sesión actual): con el cursor en CUALQUIER parte
  de una línea de opcode expandido (`{02AB:} set_char_proofs {self} [Char] {bulletProof}
  [bool] …`), TAB selecciona una casilla `[tipo]` (corchetes) a reemplazar; TABs
  sucesivos avanzan hasta cubrir todas. Solo se seleccionan los `[corchetes]`
  (reemplazables al tipear: `[Char]` → `$PLAYER_ACTOR`); los `{nombres}` de significado
  NO. Cuenta también la casilla de salida (`[int VEH_VALUE] = create_car {modelId}
  #ENFORCER [float] …`). **La casilla siguiente se elige por el CURSOR, NO por un índice
  recordado** (el índice se corrompía al rellenar — la lista de casillas se encoge y el
  TAB rápido "se saltaba" un parámetro): (1) cursor DENTRO de una casilla → esa casilla
  (re-seleccionar para tipear encima); (2) si no, la primera casilla que arranca en o a
  partir del cursor → justo tras rellenar un dato el cursor queda ahí = la SIGUIENTE;
  (3) cursor tras la última → la primera (ciclo). Mecanismo: keybinding de `tab` con
  `when` = `editorTextFocus && resourceLangId == sannybuilder && sb4OpcodeParamContext &&
  !suggestWidgetVisible && !hasSnippetCompletions && !inSnippetMode`. El contexto
  `sb4OpcodeParamContext` se actualiza en cada cambio de cursor/editor activo Y de texto
  (`onDidChangeTextDocument`), con GUARDA de valor (solo `setContext` cuando cambia: sin
  round-trips durante el llenado, donde ya estaba true); `expand.ts` lo prende SÍNCRONO
  tras F1/cycle (`armTabContext`) para que F1→TAB encadenados no esperen al evento. El
  TAB normal NO se pisa en líneas sin casillas: `insertFallbackTab` = indentar líneas
  (con selección) o insertar la indentación configurada (sin selección), y al rellenar
  la última casilla el contexto pasa a false → TAB sigue siendo el de VS Code. Validado
  con harness: 15/15 contra 02AB (1.º [Char], rellenar → SIN salto, encadenado hasta las
  5 [bool], ciclo, clic dentro de una casilla, línea completa y sin-opcode → TAB normal).
- **Recompilar en pestaña virtual sin diálogo**: `VirtualDocumentProvider` recuerda el
  destino por uri (`setTarget`/`getTarget`, persistido en `globalState`
  `sb4Tab.virtualTargets`) y F6 sobre una virtual ya establecida recompila SIEMPRE al
  mismo output (sin `showSaveDialog`); si la virtual se restauró sin destino, lo pide
  la primera vez. Recompilar desde la virtual NO re-dibuja ni cierra la pestaña activa
  (evita el "editor edita solo" que revertía los cambios recientes).
- **Métodos de clase con paréntesis**: el completado de `Text.`/`char.` inserta snippet
  `miembro($0)` (cursor dentro, listo para los argumentos).
- **Métodos de clase: firma + argumentos en el completado** (`src/providers/class/completion.ts`,
  sesión actual): al autocompletar un método, el snippet lleva UN placeholder por
  argumento en el ORDEN de la definición con `nombre: tipo`
  (`SetCoordinates(${1:x: float}, ${2:y: float}, ${3:z: float})$0`; Tab los recorre y el
  `$0` final sale del paréntesis). El receptor `self` (el objeto/variable antes del `.`)
  NO entra como argumento (ya está escrito): `Char.Delete` → `Delete()`; `Camera.Shake`
  → `Shake(${1:intensity: int})`; `Text.Print` (clase global) → `Print(${1:key: gxt_key},
  ${2:time: int}, ${3:flag: int})`. `item.detail` muestra la firma COMPLETA incluido
  `self: Char` (receptor primero, con su tipo); `documentation` = bloque `sb` con la
  firma, la descripción de sa.json y una tabla `# | arg | tipo` donde `self` suma con
  `—` y negrita. Los placeholders escapan `$ {} \` (`escapeSnippet`). Fallback builtin
  (sin sa.json) sigue con `miembro($0)`. Validado con harness: 12/12 contra sa.json real
  (Char.Delete/SetCoordinates, Debugger.Line f1..f6, Player.Create, Camera.Shake, Text.Print,
  y balance de `$` `{` en los 2382 members).
- **Coordenadas dentro de métodos de clase** (`sb4.insertCoordinates`): si el cursor está
  dentro de `Clase.metodo(` se insertan separadas por COMA; NO añade coma separadora si
  ya hay una al final del paréntesis (`Char.Create($scplayer, ` → coords directas, sin
  `, ,`). Fuera de método de clase → `x y z` con espacios (estilo opcode clásico).
- **Openers al final de línea** (comentarios): `/*` o `{` solos al final se pintan como
  comment; `{00A5:}` se colorea comment entero sin symbols fantasma.
- **Repintado estructural inmediato**: insertar/borrar líneas o pegar con saltos repinta
  YA (sin ventana donde la decoración vieja anclada a offsets dejaba el pegado "todo
  rojo"); el análisis completo de todas formas tocaría hacerlo 16 ms después.

## Archivos clave

- `src/providers/opcode/format.ts` + `expand.ts` (SBL/`, código comentado, F1 expand/ciclo), `src/components/virtual-document-provider.component.ts` (targets persistidos).
- `src/i18n/catalog.ts` (catálogos en/es + `CATALOGS`/`CATALOG_INFO`/`DEFAULT_LANGUAGE`), `src/i18n/locale-manager.ts` (LocaleManager), `src/i18n/index.ts` (re-export `t`, `LocaleManager`, tipos). Alias `@i18n` en tsconfig.
- `src/lexer/tokenizer.ts`, `src/lexer/token-kind.ts` — tokens (Number/Float/String/LocalVar/GlobalVar/LabelJump/LabelDefine/Model/ArraySize…).
- `syntax/fxt.tm-language.json` + `fxt-language-configuration.json` + `configurationDefaults` (`files.encoding: windows1252`) + `src/components/fxt-encoding-guard.ts` — soporte `.fxt` (lenguaje `sannybuilder-fxt`).
- `src/providers/syntax/syntax-coloring-provider.ts` — analyze()+classifyToken+decorations; `KEYWORDS`; `memberNames`/`className`/`enumNames`.
- `src/managers/syntax-color-manager.ts` — esquema, themes, Theme Creator backend.
- `src/components/theme-creator.ts`, `rgb-color-picker.ts`, `virtual-document-provider.component.ts`, `recent-file-autosave.component.ts` (caché autosave + scheme `sb4-recent`), `extension-settings.component.ts` (webview `VB4: Settings`), `index.ts` (alias `@components`).
- `src/managers/webview-manager.ts` — inyección `{{cssUri}}/{{jsUri}}/{{localeScript}}`; `src/views/opcodes/index.html` + `script.js` (applyLocale).
- `src/compiler-tools/command-base.ts` (+ compile-command, decompile-command, developer-tools, game-splash-guard) — F6/F7, F8 quick load, pestaña virtual, `CompileExtPref`.
- `src/utils/types.ts` (`StorageKey`), `src/extension.ts`, `package.json` + `package.nls.json`/`package.nls.es.json` (config `sb4.autosave.enabled/.mode/.maxAgeDays`, comando `sb4.openSettings`), `tsconfig.json` (alias `@components/@managers/@providers/@utils/@i18n`).
- `src/managers/gta-version-manager.ts` (lee `data\<id>\mode.xml` → identificador + path del JSON).

## Pendientes / notas

- **Soporte .fxt HOY**: pendiente verificar en vivo con F5: abrir un `.fxt` ANSI con
  acentos → se ve bien en VS Code, Ctrl+S no corrompe y el juego/SB4 lo siguen leyendo
  bien; y que el toast de un archivo ya corrupto (U+FFFD) o de un `.fxt` UTF-8 salte al
  abrirlo. El archivo YA corrompido del usuario no se recupera automáticamente (los
  acentos fueron reemplazados por U+FFFD en disco) → restaurar desde backup.
- **FXT: sin autocompletado + entrada siguiente + errores simples HOY**
  (`src/providers/fxt/fxt-next-entry.ts` y `src/providers/fxt/fxt-diagnostics.ts`):
  - Comando `sb4.nextFxtEntry` (Ctrl+Shift+Enter, solo en `.fxt`): incrementa el sufijo
    NUMÉRICO (`A0@00` → `A0@01`) de la entrada GXT actual o de la más cercana arriba.
    La nueva línea NO copia el texto: queda el id incrementado y, si el texto previo
    arrancaba con `~z~`, ese marcador (`B1@69 ~z~...` → `B1@70 ~z~`). Con sufijo no
    numérico (ej. `A0@ZZ`) NO dispara.
  - `FxtDiagnostics` (`sb4-fxt`, debounce 300 ms): detecta (1) entries GXT de más de 7
    caracteres (sin contar el `~z~` opcional) y (2) espacio vacío al final de la línea
    (impide que el juego la muestre). Ignora líneas en blanco y comentarios `//`. Códigos
    `gxt-entry-length` / `gxt-trailing-space`, severity Error, source SB4.
  - Validado por harness (sim-fxt-next-entry 11 PASS, sim-fxt-diag 13 PASS); pendiente
    verificar en vivo con F5.
- Los 6 issues de la sesión resueltos (recompilar virtual sin diálogo, formato SBL
  `{00A5:}`, F1 expand-ciclo, repintado estructural, openers de comentario, snippet de
  método + coords con comas). El detalle de la coma extra en coords
  (`Char.Create($scplayer, ` → `, ,`) se corrigió HOY en `coords-provider.ts`
  (`trimmed.endsWith(',')`); validado por harness, pendiente verificar en vivo con F5.
- **Caché + reapertura de pestañas virtuales HOY**: persistencia de contenido+destino
  (ya existía en `globalState`) + pasada `restoreOpenTabs()` al arranque (reabre las que el
  workbench no restaure y reaplica idioma/coloreo). Pendiente probar en vivo: compilar →
  cerrar VS Code → reabrir → la tab virtual reaparece con su nombre/destino y F6 recompila
  sin diálogo.
- **Coloreo (sesión actual)**: verificar en vivo con F5 → Reload Window + F6:
  `-1655.8176 3.3946 2.5495` (signo coloreado como número), un `Text.Draw(...)`
  (clase Text + member como command, aunque no haya carpeta/versión SB4
  seleccionada) y sensación instantánea al tipear en un archivo grande
  (main.scm). Validado por harness (dist, stub de vscode): negativos,
  Text.Draw, heredados de bloque/llaves, dot entre líneas, incremental OK.
- **Autosave del archivo reciente HOY** (`RecentFileAutosave`): al terminar cada línea de
  un `.sb/.scm/.fxt` abierto se guarda el texto COMPLETO (de lo que había cambiado del
  original) en la caché virtual `sb4-recent-autosave.json` (globalStorage, esquema
  `sb4-recent`, sin tocar el disco). Al reabrir VS Code restaura una pestaña virtual
  editable con ese código (omitiendo si el disco ya tiene el mismo texto o si el documento
  ya está abierto), y Ctrl+S la escribe de vuelta al archivo real (round-trip CP1252, fallback utf-8).
  Modos `autosave.mode`: `recent` (solo el último archivo) / `all` (hasta 20). Config
  `sb4.autosave.*` en package.json; webview de ajustes generales vía comando `VB4: Settings`
  (`extension-settings.component.ts`). Validado por harness (sim-autosave: 20 PASS); pendiente
  verificar en vivo con F5: tipear → Reload Window → la tab virtual reaparece con el código.
- **Limpieza de caché de autosave HOY**: `runSweep()` se ejecuta al arrancar (antes de
  restaurar tabs) y elimina entradas cuyo archivo real ya no existe en disco o que superan
  `sb4.autosave.maxAgeDays` (default 7, 0 = sin límite de edad). Botón "Vaciar caché" manual
  sigue en la webview de ajustes, que ahora también expone el input de días. Validado por
  harness (sim-autosave pasó a 20 PASS); pendiente verificar en vivo con F5.
- Copia instalada sincronizada con robocopy `/MIR` (eliminó `.vsixmanifest`, `main.txt`, `logo.jpg`, `LICENSE.txt` legacy; si VS Code notifica la extensión como corrupta/desinstalada, reinstalar con `code --install-extension` con VS Code cerrado).
  - Comando de sync (con `/XF .vsixmanifest` para NO borrar el manifest del VS Code instalado):
    `robocopy "C:\Users\JM\source\repos\Prisma Launcher\Prisma Launcher\visual-builder4" "C:\Users\JM\.vscode\extensions\eos-mixel.visual-builder-4-0.0.1" /MIR /XF .vsixmanifest /R:2 /W:2 /MT:16 /NFL /NDL /NP` (exit `≤7` OK, `≥8` error).
  - Tras el sync: **Reload Window** en el VS Code normal; si la ext. aparece corrupta, reinstalar el `.vsix`: `code --install-extension visual-builder-4-0.0.1.vsix` (VS Code cerrado).
- Working copy commit: `1509a19` (bug theme-creator + categorías keywordsIf/Switch/Loop/Boolean corregidos DESPUÉS del commit, pendiente verificar en vivo y commitear).
- Categorías: los temas/.ini viejos con `keywordsFlow.*` quedan sin efecto (las entradas se parsean pero no se usan); regenerar desde el Theme Creator o `sb4.customizeColors`.
- F8 quick load: verificar contra la versión real del juego (si ya tiene mods que reemplazan `movies\` o SilentPatch con `SkipIntroSplashes=1`, el renombrado no encuentra nada y lanza igual).
- Código: tabs, camelCase, single quotes, sin comentarios salvo que se pidan.
- El contexto documenta el ESTADO; los cambios del momento se describen brevemente y se integran, no se acumula historial.