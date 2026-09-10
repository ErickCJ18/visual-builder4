# Contexto del proyecto — Visual Builder 4 (fork de sb4-vscode)

## Qué es esto
Extensión de VS Code para escribir y compilar scripts de **Sanny Builder 4** (herramienta de scripting para GTA III/VC/SA, formato `.scm`/CLEO). Es un fork de [`NoPressF/sb4-vscode`](https://github.com/NoPressF/sb4-vscode), mantenido ahora en [`ErickCJ18/visual-builder4`](https://github.com/ErickCJ18/visual-builder4).

La extensión no compila nada por sí sola: llama al `sanny.exe` real de tu instalación de Sanny Builder 4 (vía línea de comandos) y le da encima IntelliSense (autocompletado, hover, resaltado, snippets) sobre los opcodes/clases/enums de esa instalación.

## Cómo compilar / empaquetar el proyecto
```bash
npm install
npm run compile          # tsc + tsc-alias
vsce package             # genera el .vsix
```
Requiere `@vscode/vsce` instalado globalmente (`npm i -g @vscode/vsce`).

---

## Problemas encontrados y resueltos

### 1. `.zip` sin `.vsix` / no hay Releases en GitHub
El repo original no publica binarios compilados — hay que generar el `.vsix` a mano con `vsce package`.

### 2. Mismatch `engines.vscode` vs `@types/vscode` (bloqueaba `vsce package`)
`package.json` tenía `engines.vscode: ^1.98.0` pero `@types/vscode: ^1.108.1`. `vsce` rechaza empaquetar si el segundo es mayor que el primero.
**Fix aplicado:** subir `engines.vscode` a `^1.108.0`. ✅ Commiteado.

### 3. Crash de `sanny.exe` al compilar (`EAccessViolation`, lectura en dirección `0x08`/`0x20`)
Causa: nunca se había seleccionado la versión de GTA en el botón de la barra de estado ("SB4 (Select version)"). El código arma el comando así (`src/compiler-tools/command-base.ts`):
```
sanny.exe --no-splash --mode <identificador> --compile <archivo>
```
Si `gtaVersionManager.getIdentifier()` es `undefined` (nunca se eligió versión), el `--mode` queda mal formado y `sanny.exe` crashea al arrancar.
**Fix:** seleccionar la versión de GTA antes de compilar. Resuelto por el usuario.

### 4. Confusión: el `.scm` compilado se ve "corrupto"
El `.scm` es bytecode binario (no texto). Abrirlo como texto en VS Code muestra símbolos raros / recuadros rojos — es normal, no es un error. Para ver el resultado en texto legible hay que usar **Decompile Script** sobre ese mismo `.scm`.

---

## Análisis: estructuras de control soportadas

Confirmado contra la documentación oficial de Sanny Builder y contra el repo [`Dryxio/cleo-ai`](https://github.com/Dryxio/cleo-ai) (repositorio de referencia para agentes de IA, no una extensión):

| Estructura | ¿La compila SB4? | Resaltado | Snippet | Auto-indent/folding |
|---|---|---|---|---|
| `IF...THEN...END` (+`ELSE`, `AND`/`OR`) | ✅ | ✅ | ❌ | ❌ |
| `WHILE...END` | ✅ | ✅ | ❌ | ❌ |
| `REPEAT...UNTIL` | ✅ | ✅ | ❌ | ❌ |
| `FOR...END` (`TO`/`DOWNTO`) | ✅ | ✅ | ✅ (único existente) | ❌ |
| `SWITCH...CASE...DEFAULT...END` | ✅ | ✅ | ❌ | ❌ |
| `BREAK`/`CONTINUE` | ✅ | ✅ | ❌ | — |
| `FUNCTION...END` (CLEO5+) | ✅ | ✅ | ❌ | ❌ |

Todas compilan (eso lo hace `sanny.exe`, no la extensión). La extensión solo colorea las palabras clave; el único snippet real es para `FOR`.

## Carencias frente a las reglas de `cleo-ai`

`cleo-ai` documenta reglas estrictas (`AGENTS.md` + `config/target-profile.json`) para no romper scripts. La extensión, comparada línea por línea contra esas reglas:

| Regla de cleo-ai | Estado en la extensión |
|---|---|
| No sugerir opcodes `unsupported`/`nop` | ❌ El dato `isUnsupported` existe pero solo se usa (tachado) en el panel de búsqueda; el autocompletado normal y el hover no lo filtran ni avisan — **próximo cambio planeado** |
| Todo loop debe tener `wait` | ✅ Implementado (ver commits) |
| Liberar modelos (`mark_model_as_no_longer_needed`) | ❌ No hay tracking |
| Extensiones opt-in requieren `{$USE}` | ❌ No se valida |
| `script_name` máx. 8 caracteres | ❌ No se valida |
| Signature help de parámetros en vivo | ❌ Solo hay formato en hover/completado, no validación de conteo de argumentos |
| Análisis de scope de funciones | ❌ No existe |
| Límite de tamaño de arrays locales | ❌ No existe |
| Validación estática pre-compilación | ❌ Todo depende de que `sanny.exe` falle y genere `compile.log` |

---

## Cambios ya commiteados (rama `claude/tooling-improvements`, mergeada a `main`)

Se entregaron como un **git bundle** (`tooling-improvements.bundle`) porque no hay acceso de push directo al fork del usuario. Se aplicó con:
```bash
git fetch ./tooling-improvements.bundle claude/tooling-improvements:claude/tooling-improvements
git checkout claude/tooling-improvements
# revisado, luego:
git checkout main
git merge claude/tooling-improvements
git push origin main
```

### Commit 1 — `fix: align engines.vscode with @types/vscode version`
Ver problema #2 arriba.

### Commit 2 — `feat: warn on WHILE/REPEAT loops missing wait`
Archivo nuevo: `src/providers/diagnostics/loop-wait-diagnostics.ts`, registrado en `extension.ts` (`LoopWaitDiagnostics.getInstance().register()`).
- Marca en amarillo (warning) cualquier `WHILE...END`/`REPEAT...UNTIL` sin `wait` en su cuerpo.
- Usa el `Tokenizer` existente (antes no se usaba en ningún lado del código), pero con `new Tokenizer()` en vez de `.getInstance()` para evitar que el singleton acumule tokens de análisis anteriores.
- Re-analiza con debounce de 400ms al editar.
- **Limitaciones conocidas (documentadas en el propio código):** es heurístico por texto, no análisis real de flujo (un `wait` dentro de un `IF` sin `ELSE` igual "cuenta"); no distingue comentarios de bloque `/* */` porque el tokenizer compartido tampoco los reconoce.

### Commit 3 — `feat: add file icon for the SB language`
En `package.json`, `contributes.languages[0].icon` con `light`/`dark` apuntando a `images/language-icon-16.png` (generado recortando/reduciendo el `logo.jpg` existente).
- Solo se ve si el tema de íconos de archivo activo tiene íconos específicos por lenguaje (temas "Minimal"/"None" no muestran ninguno).

---

## Sesión actual: completado de opcodes + selección de versión (sin commitear aún)

### Autocompletado de opcodes con línea default completa
Al aceptar un opcode en el autocompletado se inserta una línea **literal completa** (sin tab-stops), con el id del opcode, la salida tipada y los parámetros con su tipo:
```
00A5: [var handle: Car] = create_car {modelId} [model_vehicle] {x} [float] {y} [float] {z} [float]
009A: [var handle: Char] = create_char {pedType} [PedType] {modelId} [model_char] {x} [float] {y} [float] {z} [float]
```
- `src/providers/opcode/completion.ts`: `item.insertText = buildDefaultLine(command)`; helpers `buildDefaultLine`, `formatOutput`, `formatArg`, `formatCommand`. El hover/documentation muestra las variantes (output + params).
- `Command.id?: string` añadido en `src/utils/types.ts` y poblado en `src/managers/command-manager.ts` (`id: rawCommand.id`).

### Provincia de la selección de versión
Antes la versión solo se elegía con el botón de la barra de estado `SB4 (Select version)`, y eso **no recargaba los datos**: `CommandManager.load()` solo corría en la activación, así que si no habia versión guardada al arrancar, el autocompletado quedaba vacío para siempre.

**Cambios:**
- Comando nuevo `sb4.selectVersion` ("SB4: Select GTA Version") en `package.json` y registrado en `src/extension.ts`.
- `handleVersionSelection` pasó de `private` a `public` en `src/components/gta-version-button.component.ts` e implementa la **cadena de recarga** completa al elegir versión:
  - `CommandManager.reload()` → `load()`
  - `CommandFormatterProvider.reload()` → `formatAll()`
  - `ClassProvider.reload()` → `parse()`
  - `OpcodeProvider.reload()` → `load()`
  - `EnumProvider.reload()` → `load()`
  - `OpcodesSearch.updateWebviewContent(true)`
- Los métodos `reload()` se agregaron a los 4 providers (recargan datos **sin** re-registrar providers para no duplicar completions).
- Feedback visible siempre: mensaje de éxito, "ya está seleccionada", o error concreto (antes todo fallaba en silencio).

### Workflow de pruebas: ventana NORMAL de VS Code (ya no F5)
El F5 / Extension Development Host usa un `globalState` aislado que no comparte carpeta/versión con la ventana normal, por lo que había que reconfigurar todo ahí.
**Solución aplicada:** la extensión instalada en la ventana normal (`C:\Users\JM\.vscode\extensions\eos.sb4-0.7.0`) se reemplazó por un **junction** (_symlink_) a la carpeta del proyecto (`visual-builder4`). La versión anterior quedó respaldada en `eos.sb4-0.7.0.bak`.

Nuevo ciclo de prueba:
1. `npm run compile` (o `npm run watch` en una terminal para recompilar solo al guardar).
2. En la ventana normal de VS Code: **Ctrl+Shift+P → Developer: Reload Window**.
3. Probar ahí (usa el `globalState` real: carpeta SB4 + versión ya guardados).

Nota: `dist/extension.js` debe existir antes de recargar; si no, la extensión no activa.

### Colores de sintaxis configurables por el usuario (INI estilo krauber.ini)
- `src/managers/syntax-color-manager.ts`: lee la sección `[syntax]` de un `.ini` (formato krauber.ini: enteros `0xRRGGBB` o `#RRGGBB`; estilos bold/italic/underline). Prioridad: `sb4.colors.iniPath` → `<carpeta SB4>/krauber.ini` → `syntax/sb-colors.ini` (ejemplo incluido). Watcher: los cambios al INI se aplican solos.
- `src/providers/syntax/syntax-coloring-provider.ts`: colorea por categorías (decorations) con el Tokenizer + datos reales: keywords, numbers, strings, classes, enums, commands (opcodes+miembros), variables (`$x`,`0@`), labels (`@x`,`:x`), comments, directives (`{$...}`). En `[var nombre: Tipo]` el nombre va de color variable y el tipo de color clase.
- Comandos: **SB4: Reload Syntax Colors** (`sb4.reloadColors`) y **SB4: Customize Syntax Colors** (`sb4.customizeColors`, QuickPick de categoría → picker RGB → escribe en `<SB4>/sb4-colors.ini` y configura `sb4.colors.iniPath`). El picker RGB es un WebView (`src/components/rgb-color-picker.ts`): presets + sliders R/G/B + preview en vivo + campo hex.
- `{}` también es comentario en SB (además de `//` y `/* */`); `{$...}` sigue siendo directiva. Añadido a `syntax/sb4.tm-language.json` y al provider.
- Language id renombrado de `sb` a `sannybuilder` (alias "Sanny Builder"): `package.json`, `src/utils/config.ts` (`CONFIG.LANGUAGE_SELECTOR.language`). El scopeName de la gramática sigue `source.sb4`.
- Autocompletado del opcode entero por su **código hex** (adicional al de nombre): en `src/providers/opcode/completion.ts`, cada opcode genera un item con label `009A: create_char`, `filterText` = el id en minúsculas (`009a`) e `insertText` = la línea default completa. Ej: escribir `009a` → aceptar → se inserta la línea de `create_char`.
- **Snippets de estructuras de alto nivel** (`src/providers/snippet/snippet-completion.ts`): if/then/end, else, while/end, repeat/until, switch/case/end, function/end. Aparecen al escribir la palabra clave y reemplazan esa palabra al aceptar (item.range). El `for` lo cubre el snippet de archivo `snippets/snippets.json`.
- **Autocompletado no intrusivo** (`src/providers/opcode/completion.ts`): con tecleo automático solo se devuelven opcodes que coinciden con la palabra escrita (`filterText.includes(word)`); las **keywords** de SB (if, then, end, while, etc. — set `KEYWORDS` exportado de `syntax-coloring-provider.ts`) no disparan opcodes nunca; tras `.` el provider de opcodes devuelve vacío (los miembros los aporta el de clases); solo con Ctrl+Space se lista todo.
- **Compilar/descompilar con F6/F7** (`src/compiler-tools/command-base.ts`): **F6** compila la pestaña activa (si está sucia se **guarda automáticamente** antes para que sanny compile el contenido actual); la primera vez de esa **pestaña/archivo fuente** abre `showSaveDialog` para elegir el destino (`.cs`/`.csm`/`.scm`) y lo recuerda en la sesión (`Map sourcePath→outputPath`), de modo que los siguientes F6 no vuelven a preguntar. Se pasa como `--compile <input> <output>` (sanny.exe acepta el parámetro de salida). **F7** descompila y *siempre* abre `showOpenDialog` para elegir el binario. Keybindings en package.json: `f6`→compileScript, `f7`→decompileScript (reemplazó al `ctrl+shift+b`). Tras una compilación **exitosa** (log vacío o ENOENT), `showCompiledOutput` **convierte la pestaña activa en el archivo compilado**: cierra la pestaña del fuente (si está limpia) y las de un destino viejo, y abre el destino en su lugar (`showTextDocument`, sin renombrar el archivo físico; pestañas sucias se ignoran).
- **Tokenizer strings** (`src/lexer/tokenizer.ts`): bug de strings con comilla doble corregido (`c === char`). Verificado con `"PED"`, `'PED'` y `"AB\"CD"` → PASS.
- **sanny.exe lanzado directo** (`src/compiler-tools/command-base.ts`): SB4 no tiene flag headless (bug sannybuilder/dev#399). Se abandonó el wrapper VBS+cscript: `windowsHide: true` de Node/libuv aplica el mismo `STARTUPINFO`/SW_HIDE que el VBS, pero SIN el **~1.1s** de arranque de cscript.exe (medido). Resultado: compilar main.txt pasó de ~5.7s a ~4.6s (el resto es sanny cargando los `.ide` del juego configurado como `GamePath` en `E:\Sanny Builder 4\data\settings.ini`, que apunta a `E:\Stranded Deep`). Riesgo aceptado por el usuario: si parpadea la ventana, revertir al VBS.
- **Modelos/prefijo `#`** (`src/lexer/token-kind.ts`, `tokenizer.ts`, `syntax-coloring-provider.ts`): nuevo `TokenKind.Model` y `'#'` en `prefixCharTokens` → `#AK47`, `#ESPERANT` se tokenizan completos y se colorean con la categoría `models`. Antes el `#` se ignoraba y parte del nombre quedaba descoloreado.
- **Rendimiento** (`src/providers/syntax/syntax-coloring-provider.ts`, `src/lexer/tokenizer.ts`, `src/compiler-tools/command-base.ts`): el coloreado usaba `isExcluded` → O(tokens × exclusiones) → **O(n²)** en archivos grandes (un main.scm lo dejaba congelado). Ahora las exclusiones son pares `[start,end)` ordenados y se barren con **un único puntero** junto a los tokens (O(n+m)). El Tokenizer usa char-codes (`isSpaceChar/isDigitChar/isWordChar/isIdentStartChar`) en vez de regex por carácter; `spawn` con `windowsHide: true`. Benchmark: 50k líneas/500k tokens ≈ 462 ms. El compilado en sí lo ejecuta `sanny.exe` (su duración no la controla la extensión); lo arreglado es el refresco/re-render de pestañas grandes tras compilar.
- **Perfil real del proyecto (main.txt, 44.463 líneas / 192k tokens)**: el pipeline completo de la extensión lo colorea en **~300 ms** (tokenize 298 ms + regex 28 ms) → el cuello de botella NO es nuestro código, es `sanny.exe` (carga cientos de `.ide`, se vio en `core.log`). Tipos de token: 13.218 labels `:`, 2.135 jumps `@`, 11.665 `$globals`, 890 `#modelos`, 3.414 strings, 24.682 dots (API alto nivel `Car.`/`Task.`/`Audiostream.`), 703 `==`, 343 `+=`. Es un main estilo moderno (SP + misiones con diálogo GXT en español, encoding cp1252).
- **Tiempo de compilación en el resultado** (`src/compiler-tools/command-base.ts`): se mide con `Date.now()` justo antes de lanzar el proceso y se muestra en el mensaje de éxito/error de **F6/F7**: `✅ Compiling succeeded (12.3s)`. Formato: ms → `(123ms)`, segundos → `(12.3s)`, ≥60s → `(1m 23s)`. Excluye el tiempo de los diálogos (Save/Open).
- **Buffer sin guardar / untitled (bug del "10m 3s" y flujo SB4)**: compilar un documento SIN nombre (p.ej. pegar el main en una pestaña nueva) pasaba a sanny un path inexistente → sanny se quedaba **bloqueado esperando en un diálogo de error invisible** → 10+ minutos. Fix: ahora se replica el **flujo de SB4**: F6 con pestaña sin nombre → el contenido se vuelca a un **archivo temporal** (`os.tmpdir()/sb4-src-<pid>.cs`), se abre `showSaveDialog` (default **`main.scm`** en la carpeta del workspace) para elegir sobre qué compilar, y al terminar se borra el temporal y la **pestaña se reemplaza por el archivo compilado** (`swapActiveTab` cierra la tab sin nombre y abre el destino → "el nombre del archivo queda en la pestaña"). Con pestaña guardada sigue igual: se guarda si está sucia y se compila con destino recordado.
- **Extensiones al compilar**: `.cs/.csm/.scm` y **cualquier otra** (`.*`), sin restricción — el usuario confirmó "asi sin mas". El filtro del diálogo muestra las 3; el default para un fuente guardado es `<basename>.cs`.
- **La lentitud de compilar es de sanny.exe**: al lanzar `--compile`, SB4 carga los `.ide` del juego configurado (carpeta del juego en `E:\...`), lo que con main.scm (1.5 MB / 44k líneas) tarda varios segundos de forma inherente. La extensión solo mide y reporta; no hay flag headless ni opción de aceleración.
- **Coordenadas/ángulo del jugador desde memoria** (`src/providers/coords/coords-provider.ts`): **Ctrl+Shift+C** inserta coords XYZ del jugador y **Ctrl+Shift+E** el ángulo Z, leyendo la memoria del juego en ejecución (igual que SB4). Comandos `sb4.insertCoordinates`/`sb4.insertAngle`, keybindings restringidos con `when: "editorTextFocus && resourceLangId == sannybuilder"` (no roba Ctrl+Shift+C/E de VS Code fuera de scripts SB).
  - **Mecanismo optimizado: lector nativo .exe** (el delay del PowerShell ~1-2s por tecla por el `Add-Type` era notable). Ahora el P/Invoke se compila **una sola vez** en `register()`: se extrae `COORDS_CS_SOURCE` (C# puro `OpenProcess`/`ReadProcessMemory`) y se compila con `csc.exe` del .NET Framework (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, o fallback `Framework\`) hacia `read-coords.exe` en `globalStorageUri`. Cada pulsación lanza ese exe directo desde Node (`windowsHide`) en **~50 ms de media** (antes ~1-2s). Si no hay `csc.exe` o falla la compilación, se cae al script PowerShell `read-coords.ps1` (fallback).
  - **Detalle C#**: `Convert.ToUInt64(hex, 16)` **no acepta prefijo `0x`** → `normalizeHex()` lo recorta (también aplica a overrides del usuario). Args posicionales `[exe, playerPtrHex, coordsMode, angleOffsetHex]`. Salida stdout: `X Y Z A` o `NO_PROCESS`/`NO_ACCESS`/`READ_FAIL` (mismo pacto que el PS).
  - **Juegos soportados** (mapeo `GtaVersionManager.getIdentifier()` → proceso): `sa*` → `gta_sa.exe` (puntero `0xB6F5F0`, CMatrix vía `CPed+0x14`, coords `+0x30/34/38`, ángulo `CPed+0x558` rad); `vc*` → `gta-vc.exe` (`0x94AD28`, coords inline `+0x34/38/3C`, ángulo `+0x378`); `gta3*` → `gta3.exe` (`0x6FB1C8`, igual que VC; offset de ángulo sin confirmar). Overrides por juego configurables en `sb4.coords.processOverrides` (ej: `{"gta3": {"playerPointer": "...", "angleOffset": "..."}}`).
  - **Formato de inserción según contexto**: si el cursor está dentro de un `.Create(...)` de clases (Char/Actor/Vehicle/Object/etc.) inserta `x, y, z` con comas+espacio; si NO está dentro de una creación, inserta `x y z` separados por espacios. Detección heurística: regex sobre el texto de la línea antes del cursor (`\.(\w+)\s*\([^)]*$` + `/create/i`).
  - **Ángulo**: radianes → grados, normalizado a `[0,360)`. Decimales configurables: `sb4.coords.coordinateDecimals` (default 4) y `sb4.coords.angleDecimals` (default 2).
  - Errores manejados con mensajes: proceso no encontrado (`NO_PROCESS`), sin permisos de lectura (`NO_ACCESS`), puntero/lectura fallida (`READ_FAIL`), o salida inesperada. Validado en vivo: el exe nativo devuelve correctamente `NO_PROCESS` (sin juego) y `READ_FAIL` (proceso real sin puntero válido); **probado con GTA SA en ejecución por el usuario: funciona**, con el fix de latencia recién aplicado (falta confirmar que el exe nativo anda en su VS Code tras Reload).
- **Autocompletado de modelos (`#`)** (`src/providers/model/model.ts` + `src/providers/model/completion.ts`): al escribir `#` (p.ej. `#AK`) se sugieren todos los modelos de los `.ide` del juego activo, como SB4. Registrado con trigger char `'#'`; el `#` ya está en el documento → el item inserta solo el nombre y su rango cubre solo lo escrito tras el `#` (reemplazo limpio `#AK` → `#AK47`). Nombres guardados en MAYÚSCULAS (estilo SB4) pero con matching case-insensitive (`filterText` en minúsculas); orden: los que empiezan por lo escrito → los que lo contienen → resto, tope 100 items.
  - **Fuente**: flujo idéntico a SB4 — el `mode.xml` del modo activo (`data\<identifier>\mode.xml`) declara `<ide base="@game:\">@game:\data\default.dat</ide>` y `@game:\data\gta.dat`; `@game:` se resuelve al `GamePath` del modo en `E:\Sanny Builder 4\data\settings.ini` (prioridad: sección == identifier → prefijo común → primer GamePath); cada `.dat` es una lista de `IDE <ruta>` que se resuelven contra la base (raíz del juego) o la carpeta del `.dat` como fallback; cada `.ide` se parsea por secciones (`objs`/`tobj`/`hier`/`cars`/`peds`/`weap`) tomando el **nombre de modelo = 2ª columna** de cada línea de datos. Comentarios (`#`), línea `end` y secciones sin modelo ignoradas.
  - **Validado en vivo** contra `E:\Stranded Deep\data\`: 57 archivos `.ide` → **6767 modelos** encontrados (`landstal`, `buffalo`, `sentinel`, `esperant`, `camera`, `ak47`, ...). El identifier activo es `sa_sbl`, que coincide con la sección `[sa_sbl]` de `settings.ini`. Se recarga al cambiar de modo (`reloadOpcodes` en `gta-version-button.component.ts` ahora también llama `ModelProvider.getInstance().reload()`). `npm run compile` OK y **build regenerada en `sb4-0.7.0.vsix`** (786 archivos, 1.78 MB, incluye este hito). Pendiente de probar por el usuario: Reload Window y escribir `#AK` en un script SB.

---

## Cómo probar los cambios manualmente
La extensión detecta el lenguaje **por contenido**, no por extensión de archivo (`"extensions": []` en `package.json`, ver `src/managers/language-manager.ts`). Para que un archivo se auto-detecte como "SB":

1. Crea `test.txt` (o sin extensión).
2. Primera línea debe contener `script_name '...'` (o `DEFINE OBJECT SANNY BUILDER`).
3. Ejemplo para probar el diagnóstico de `wait`:
   ```
   script_name 'test'

   while true
       print_help 'sin wait'
   end

   while true
       print_help 'con wait'
       wait 0
   end
   ```
   El primer `while` debe salir subrayado en amarillo; el segundo no.
4. Para los cambios de esta sesión, probar en la **ventana normal** (junction a la carpeta del proyecto): `npm run compile` + **Developer: Reload Window**. F5 solo no vale porque aísla el `globalState`.

---

## Siguiente paso planeado (aún no implementado)
**Filtrar/advertir sobre opcodes marcados `isUnsupported`/`nop`** en el autocompletado (`src/providers/opcode/completion.ts`) y en el hover (`src/providers/opcode/hover.ts`), ya que hoy esos datos existen (`Command.attrs.isUnsupported`) pero solo se usan visualmente en el panel de búsqueda de opcodes.
