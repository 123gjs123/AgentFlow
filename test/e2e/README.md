# Tests e2e funcionales

Suite end-to-end de Agent Flow Studio. **No usa tu suscripción ni toca tus flujos.**

- Cada archivo levanta su propio servidor real (`server/index.js`) en un puerto libre.
- Cada servidor usa:
  - datos temporales (`AFS_DATA`);
  - un HOME temporal con skills y agentes de prueba;
  - un **Claude CLI simulado** (`mocks/claude-mock.mjs`).
- Al terminar, todo se borra. Si pones `AFS_E2E_KEEP=1`, los datos se conservan para revisarlos.

## Cómo correrlos

```powershell
npm run test:e2e        # salida legible
npm run test:e2e:ci     # además test-results/e2e-junit.xml (para Jenkins/GitLab/GitHub)
npm run test:release    # vite build + test:e2e:ci: lo que hay que correr antes de cada release
node --test --test-reporter=spec test/e2e/05-external-api.test.mjs                  # un archivo
node --test --test-reporter=spec --test-name-pattern="Idempotency" "test/e2e/*.test.mjs"  # tests por nombre
```

**Requisitos:**
- Node 20+ (probado con 24).
- Windows PowerShell.
- Opcionales:
  - Git Bash y Python 3, para ejecutar los clientes generados de Jenkins/GitHub/GitLab/cron.
  - Chromium vía `playwright-core`, para la suite de UI en navegador.

Lo que falte se **salta con aviso**; nunca falla en silencio.

La suite de navegador busca `playwright-core`:
1. en este proyecto (`npm i -D playwright-core` y después `npx playwright install chromium`);
2. si no está, en la carpeta que indique `AFS_PLAYWRIGHT`, por ejemplo:

```powershell
$env:AFS_PLAYWRIGHT = "C:\ruta\a\otro-proyecto\node_modules\playwright-core"; npm run test:e2e
```

Si un test de UI falla, deja la captura y el texto de la página en `test-results/ui-*.png|txt`.

## Qué cubre (375 tests)

| Archivo | Qué prueba |
|---|---|
| `01-flows` | Crear flujos (vacío, demo, **con IA**), editar el grafo (ciclos, edges inválidos), campos que gestiona el servidor, memoria, leftovers y reset, catálogo de skills/agentes (usuario + proyecto), probe del CLI, archivo de definición, servir la UI, rotar el token |
| `02-steps-and-data` | Steps de tipo **rol, skill, agente y comando** (PowerShell, cmd, bash). Lo que recibe el CLI: system prompt, prompt, `--tools` de mínimo privilegio, `--allowedTools`, modelo, effort, permisos, cwd. Datos entre steps: salidas, JSON, `{{steps.X.json.campo}}`, `{{input}}`/`{{vars}}`, modos de input full/json/summary/refs. Ramas paralelas, procedencia, `<remember>`, acciones MCP, archivos, pins, snapshot del flujo |
| `03-verification` | JSON + schema con 1 corrección (`--resume`), INVALID_JSON, SCHEMA_MISMATCH, INVALID_SCHEMA (422). Aserciones (contains, regex, json con todos los operadores, comando, juez IA con nonce), severidades. PERMISSION_DENIED / EMPTY_OUTPUT y sus excepciones, CLI_ERROR. Hooks: onStart, onSuccess, onFailure, ctx.sh/ai/remember/setVar, y hook que no compila → HOOK_ERROR |
| `04-reliability` | Reintentos transitorios (y nunca después de escribir), CLI que muere, retry de comandos, timeout de step, deadline de ejecución, cancelar/detener (se matan los procesos), cancelar durante un backoff. **Inyección** en los 3 shells, plantillas entre comillas simples y `{{{raw}}}`. Variables por ejecución aisladas, programación, límite global de procesos de Claude (`queued`), caída del servidor → `interrupted` + procesos huérfanos muertos |
| `05-external-api` | Autenticación (Bearer, X-AFS-Token, ?token), listar flujos (solo nombres de variables). run con wait, asíncrono + polling, eventos por `seq`, 202 timedOut, cancelar, un solo step, errores con código, formatos de cuerpo (texto, objeto, webhook crudo, JSON roto). Pins en externo, **Idempotency-Key**, dryRun, ask, registro de llamadas recibidas. Guardas de la UI (proxy, Origin, Host, Content-Type) y WebSocket |
| `06-cli-mcp` | `afs`: list, run (`-i`, `-f`, stdin, `--var`, `--step`, `--json`, `--follow`, `--dry-run`, `--key`, `--pins`, `--deadline`, `--timeout`, `--no-wait`), status, cancel, ask, y los exit codes 0/1/2/3. **MCP** stdio: initialize, tools/list, las 5 tools, isError y structuredContent |
| `07-integrations` | **Los 12 orígenes ejecutando el código generado**, con datos hostiles. Ver la tabla de orígenes más abajo. También: alcance, URL pública, lint (casos negativos), Adaptar con IA (redacción del token, corrección, error) y el verificador de plantillas |
| `08-chat-and-context` | Chat de step: sesión, el contexto solo se reenvía si cambió, propuestas y aplicar, memoria, modo mejora, sesión perdida → sesión nueva, borrar chat. Chat general: el enrutador deriva al step o al flujo, ejecuta un step o el flujo, y cae al flujo si la respuesta no sirve; streaming por WebSocket. **Caja de contexto = exactamente lo que recibe el CLI** (system, prompt y flags), borradores sin guardar, todos los avisos |
| `09-ui-browser` | En Chromium real, sobre el código fuente (Vite): bienvenida, crear flujo vacío o demo (con los diálogos), eliminar, crear con IA, abrir desde el selector, ejecutar y ver los steps en verde, pestañas Contexto/Actividad/Datos, chat general, asistente de integración (Generar + Probar + indicador "llamada recibida" con una llamada real de Jira simulada), servidor caído → aviso → reconexión |
| `10-routing-and-breaks` | Spec 18 en el motor y la API: lados de las flechas, fan-out/fan-in con el mismo output repartido por campo, condiciones en flechas (json, regex) con ramas "no enrutadas" en cascada, el step decide destinos y contenido por destino (`<route to>`) — también un comando —, caja de contexto con flechas, breaks antes/después (continuar, editar, re-ejecutar con corrección, omitir, detener), deadline en pausa, ramas paralelas en pausa, API externa con `breakpoints:true`, caída en pausa → interrupted, biblioteca de steps |
| `11-ui-routing-breaks` | Lo mismo en el navegador: dibujar una flecha de abajo hacia arriba y una segunda salida, configurar la flecha (campo, condición), ver "no enrutado", poner un break, editar la salida en la ventana de revisión, re-ejecutar con corrección, duplicar y reutilizar desde "Mis steps" |
| `12-multi-tab` | Spec 19: revisiones y 409 al guardar sobre una versión vieja, propuestas del chat / ctx.setVar / reset suben la revisión, difusión entre pestañas (guardar, crear, renombrar, borrar), merge de 3 vías (unidad), y en el navegador: dos pestañas con flujos distintos (URL, título, recarga) y el mismo flujo editado a la vez en dos pestañas sin pisarse |
| `13-history-versions-chat` | Spec 20: versiones automáticas (estado inicial + intervalo, 0 = apagado), con nombre, restaurar (conserva lo ejecutado, se puede deshacer, 409 con ejecución en curso), lógica de deshacer/rehacer (solo su acción), y en el navegador: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z y ↶ ↷, pestaña Versiones, mover una flecha a otros puntos, chat con Enter / Alt+Enter / Shift+Enter |
| `14-context-sources` | Spec 21: las fuentes de contexto NO van en el prompt (índice + acceso: --add-dir, Read/Grep/Glob, WebFetch, herramientas de Atlassian), contexto del flujo para todos los steps, plantillas en referencias, fuente inexistente = aviso, vista previa = lo enviado, chat con acceso, API de comprobar / explorar carpetas / subir documento / saneo, y en el navegador: sección 📎 Contexto con explorador, ✓, insignia y contexto del flujo |
| `15-workspace-finally-access` | Spec 22: directorio de trabajo inexistente → CWD_MISSING (UI, API, dry run, vista previa) y aviso sin directorio solo en steps que escriben; "Al terminar" en éxito/error/detenido/caída del servidor, sin cambiar el resultado, no en steps sueltos, saneado y con 422 para raw externo; {{run.id}}/{{run.short}}/{{run.date}}; acceso de terminal restringida (git sin push, docker, sin web) |
| `16-requirements-preflight` | Spec 23: comprobaciones de herramienta (instalada / falta / falla su chequeo), archivo, variable, URL y conector MCP; archivo de secretos desde plantilla (no sobrescribe, avisa mientras falten valores, CRLF); bloqueo 412 en UI, step suelto, API, afs y dry run, lo recomendado no bloquea; sugerencias; y en el navegador: aviso en la barra, ventana "Antes de ejecutar", crear desde plantilla y ejecutar |
| `17-export-import` | Spec 09: exportar (formato, nombre, sin estado de la máquina ni secretos, opciones), ida y vuelta entre dos instalaciones, cuarentena (UI, step, API, dry run, chat, ask; un guardado no la quita; "Revisé, habilitar" la libera), flujo sin nada ejecutable sin revisión, archivos inválidos o más nuevos, saneo, CLI `afs export`/`afs import`, y en el navegador: descargar, importar, aviso y habilitar |
| `18-break-chat` | Spec 24: chat dentro del break con la entrada y la salida reales (`<run-review>`), propuestas de comando, variables y formato de salida (con saneo), "re-ejecutar con los cambios" (después) y "ejecutar con los cambios" (antes), sin `reload` la ejecución conserva su copia; en el navegador: abrir el chat, aplicar y re-ejecutar, y reemplazar la salida de un step de texto (texto escrito en "Datos JSON" → "Usarlo como salida") |
| `19-conversational-chats` | Spec 25: conversación de ida y vuelta (pregunta, propone, ajusta con otra propuesta, descartar, aplicar una vez), habla como su rol/agente/skill, cambios a archivos de la skill/agente solo al confirmar y solo en su carpeta, chat del flujo (descripción, variables, contexto, varios steps) y ejecuciones propuestas (con requisitos), entregable corregido en el break, propuestas desde el chat general, con el flujo en ejecución solo conversa el step en break (409 al resto, cancelar respuesta no frena la ejecución), ask externo sigue el proceso (ejecuta y recuerda directo); en el navegador: Aplicar / Descartar |
| `20-credentials` | Spec 26: alta/edición/borrado sin devolver secretos, cifrado en disco con la clave fuera de data/, uso en comandos (variable de entorno, •••• en la salida y la actividad, nunca en prompts), credencial faltante bloquea con su ítem (UI, step, API, dry run), probar conexión (Jira OK / 401), importar desde .env, exportar sin credenciales y aviso al importar; en el navegador: alta con el token oculto (desde ⚙ Configuración) |
| `21-attention-notify` | Spec 27: breaks de cualquier flujo (UI y API) con su destino y sin reanudar nada; fallos (MCP_UNAVAILABLE → CLI; solo un éxito completo limpia, un step suelto manual no); "visto" según el estado (409 / reaparece); cuarentena y bloqueo por credencial; leer la lista nunca usa la red; rendimiento con 2000 ejecuciones; notificaciones (opt-in, sin datos de la ejecución, sin la clave en el enlace, juntas sin perderse, sin repetir); programadas (primer fallo y recuperación); configuración validada; chequeo de instalación; reinicio con break pendiente (un solo resumen) |
| `22-ui-attention` | Spec 27 en el navegador: break en otro flujo → aviso "Abrir", 🔔 con contador, título "(1)", prefijo ⏸, Ctrl+Shift+A y Esc, "Abrir" lleva a la revisión sin reanudar; "Marcar visto" y "Ver ejecución"; ⚙ Configuración con sus pestañas |
| `23-flow-review` | Spec 28: seguridad de propuestas (bypassPermissions y Bash sin patrón nunca; ampliar acceso = 409 `WIDEN_CONFIRM` hasta confirmarlo aparte); lint sin llamar a Claude (skill inexistente, MCP no cargado según el CLI, escrituras externas, secreto enmascarado, suite larga); aplicar un arreglo, descartar con motivo y reaparecer si el step cambia; políticas validadas y aplicadas al ejecutar (herramientas bloqueadas, autor de git, sin trailer, ambiente por defecto, regla en el prompt, "nunca dos a la vez"); revisión de corridas (denegaciones por la forma del comando, falso éxito en segundo plano, comando cortado); ensayo (modo plan, comandos que escriben omitidos, sin "Al terminar", sin tocar lastRun ni 🔔); revisión con IA (2 llamadas read-only con el mismo dossier, evidencia verificada, desacuerdo y arreglo estructural, propuesta que inserta un step); nunca durante una ejecución y cancelada por una; chat de revisión (@rol, regla de flujo y de máquina); 🔔 kind review; políticas en el export |
| `24-ui-flow-review` | Spec 28 en el navegador: el aviso lleva a 🩺 Revisión; aplicar un arreglo; el que amplía acceso pide confirmación (cancelar no cambia nada); descartar con motivo; agregar una regla del flujo y una de la instalación (⚙ › Reglas); "✅ Aplicar las seguras" parte un step y deja aparte lo que quita algo |
| `25-flow-review-investigate` | Spec 28, ronda 2: git de solo lectura (lee los repos del flujo, rechaza escrituras, programas y otras carpetas); evidencia completa de las ejecuciones en archivos; el investigador y sus hechos verificados por la app (los inventados se descartan); partir, quitar y reconectar steps (todo o nada, sin ciclos); "aplicar las seguras" con versión previa; el chat de revisión también investiga; reparación de un JSON roto |
| `26-coordinator` | Spec 30: el coordinador elige por dónde entra cada pedido (un step a mitad de camino corre aunque lo anterior no); una flecha que depende de su decisión (`when.from`); uno por flujo; en el chat general atiende él, consulta al step que sabe y responde con lo que dijo |
| `29-outputs` | Spec 14: entregables (.feature/JSON/CSV, chequeo de formato, copia, descarga UI/API, handoff), acción automática con solo sus herramientas MCP y sin duplicar, acción que no llama a la herramienta = fallida, política sin escrituras, confirmar/aprobar con datos editados/rechazar, ensayo = dryRun, HTTP POST con credencial a su origen, cuarentena al importar, UI |
| `30-step-invoke` | Spec 12: cada step se llama desde fuera (slug estable, `…/steps/:step/run` solo o "desde", `?format=text` sin jq, `afs --from`, MCP `from`, snippets pegados en bash y PowerShell que funcionan, INVOKE.md al día, migración de slugs al arrancar) |
| `31-skill-sources` | Spec 13: skills desde URL git/tree/zip/SKILL.md (offline: insteadOf + HTTPS con cert de prueba), carpeta copiada o vinculada, zip; revisión antes de instalar; solo este flujo (`--add-dir`) o Mi Claude Code con confirmación; zip-slip/enlaces/límites/SSRF/TLS/hooks; conflictos; exportar/importar; actualizar con diff y archivos; UI |
| `32-skill-updates` | Spec 13 completo: actualizaciones de skills (git ls-remote / ETag 304 / hash; segundo plano sin ventanas de credenciales y con freno; resultados viejos descartados; aviso 🔔; programador sin cuarentena), paquetes con referencia a la URL de origen, proxy corporativo explícito (CONNECT a la IP revisada, TLS por el túnel, NO_PROXY, 407), skills de Mi Claude Code gestionadas, UI |
| `33-flow-isolation` | Spec 11: carpeta propia por flujo (los de antes siguen en tu carpeta hasta activarla), token por flujo (solo abre su flujo; admin desactivable; atado a la máquina; nunca en claro), step 🔀 Flujo y ctx.invokeFlow (solo el input, resultado de vuelta, recursión y 5 niveles, cancelar, cuarentena), llamadas entre flujos, un comando no encuentra los secretos de la app, UI |
| `34-flow-folders` | Spec 09: una carpeta por flujo (flow.json portable, state.json de la máquina), migración automática de la carpeta vieja (respaldo completo, cortes en cada fase, archivo bloqueado, re-ejecución que solo agrega), correr solo toca state.json, renombrar la carpeta al reiniciar, borrar |
| `35-linked-folders` | Spec 09: carpetas vinculadas (p. ej. un repo git): cuarentena al vincular y ante cambios de afuera que tocan lo que se ejecuta, detiene lo que corre, conflicto, carpeta desenchufada, rutas prohibidas, ids, git limpio y sin secretos, mover/desvincular/volver a vincular/borrar, importar una carpeta, 📂 y README, CWD_IN_DATA |
| `36-ui-flow-folders` | Spec 09 en el navegador: 🔗 vincular y mover, selector agrupado (🔗, no disponible), 📂, banner de revisión de un vinculado |
| `28-watch` | Spec 10 🔔 Novedades: rama git (primera foto, commits nuevos, se acumulan hasta "Visto", aviso 🔔), archivos y comando elemento por elemento, error sin perder la foto, Jira con Haiku de solo lectura (la app hace el diff), "ejecutar desde este step" y API externa `/status`, URL (ETag / contenido / HTTP de error), polling saneado, UI con 🔔 en el nodo |
| `27-for-each` | Spec 15 DATA-10: "para cada": un step corre una vez por elemento de una lista JSON de arriba (`{{item.key}}`, `$env:AFS_ITEM`), de a N, junta los resultados en una lista; si uno falla los demás corren; lista vacía omite lo que sigue; origen que no es lista da error claro; UI 🔁 |

Cómo se simula cada origen en `07-integrations`:

| Origen | Cómo se simula |
|---|---|
| Jira Cloud | Smart values renderizados, por túnel con X-Forwarded-For |
| Jira DC | Smart values renderizados |
| Jenkins | Agente Linux (`sh` + python3) y agente Windows (`powershell`); exit 1 si el flujo falla, exit 2 con token malo o servidor caído |
| GitHub / Bitbucket / GitLab | Nube por túnel y runner local |
| Tarea programada de Windows | Se ejecuta el script generado |
| cron | Se ejecuta el script generado |
| Python | Se ejecuta el script generado |
| Claude Code vía MCP | Se usa el comando de registro generado |
| Webhook | Cuerpo de la plantilla, payload propio de la herramienta y `?token=` |

En cada caso se verifica que la ejecución llegue con su input, variables, origen e Idempotency-Key, y que un reintento devuelva la misma ejecución.

## El Claude simulado (`mocks/claude-mock.mjs`)

Habla el mismo `stream-json` que `claude -p`.

- Registra cada llamada (argv, prompt, system prompt y cwd) en `claude-calls.jsonl`. Los tests leen esas llamadas con `s.calls()` / `s.callsSince(n)` / `s.argOf(call, '--tools')`.
- Recuerda las sesiones que crea: un `--resume` de una sesión desconocida falla igual que el real.

Responde según **quién llama**:
- juez de aserciones: aprueba si la salida contiene `APROBADO`;
- resumidor;
- enrutador;
- generador de flujos;
- adaptador de integraciones;
- chats.

En los steps, el comportamiento se elige con **directivas en la tarea o el rol**:

| Directiva | Efecto |
|---|---|
| `[[mock:say TEXTO]]` | responde TEXTO |
| `[[mock:echo]]` | devuelve el prompt recibido (para comprobar qué llegó) |
| `[[mock:json {...}]]` | responde con un bloque ```json |
| `[[mock:badjson-then-fix {...}]]` | 1.ª respuesta sin JSON; la corrección (`--resume`) devuelve el JSON (`never` = nunca lo corrige) |
| `[[mock:empty]]` | salida vacía |
| `[[mock:deny Herramienta]]` | permiso denegado |
| `[[mock:tool mcp__x__y]]` / `[[mock:write RUTA]]` | eventos tool_use/tool_result (acciones / archivos) |
| `[[mock:remember HECHO]]` | agrega `<remember>` |
| `[[mock:propose {...}]]` / `[[mock:propose-invalid]]` | propuesta `<step-update>` en chats |
| `[[mock:sleep SEG]]` | tarda SEG segundos (cancelar, timeouts, cola) |
| `[[mock:transient-once CLAVE]]` / `[[mock:transient-always]]` | API Error 500/529 (una vez / siempre) |
| `[[mock:write-then-transient]]` | escribe y luego falla (no debe reintentar) |
| `[[mock:crash]]` / `[[mock:error MSG]]` | el CLI muere sin resultado / error fatal |
| `[[mock:route ask\|run_step\|run_flow ID texto]]` | decisión del enrutador del chat general |
| `[[mock:gen-fail]]`, `[[mock:adapt-token]]`, `[[mock:adapt-garbage]]` | fallos del generador y del adaptador |

## Puntos de prueba en el código de la app (inocuos en producción)

- `CLAUDE_BIN` terminado en `.js`/`.mjs`/`.cjs` se ejecuta con el mismo Node (`server/claude.js`, `claudeSpawn`).
- `AFS_TIME_SCALE` escala las esperas de los reintentos transitorios (30 s / 120 s) y el intervalo de las programaciones. La suite usa 0.01. Sin la variable, la escala es 1.

## Agregar un test

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'mio' }); await s.start(); });
after(async () => { await s?.stop(); });

test('mi caso', async () => {
  const a = role('Paso', '[[mock:json {"ok":true}]]', { output: { format: 'json' } });
  const f = await s.flow('Mi flujo', [a]);
  const r = await s.runExt(f.id, { input: 'x' });           // o s.runUi(f.id, 'x')
  assert.equal(r.body.status, 'success');
});
```

Helpers disponibles:
- **API:** `s.ui()` / `s.uiOk()` (API local), `s.ext()` (API externa con token).
- **Flujos y ejecuciones:** `s.flow()`, `s.runUi()`, `s.runExt()`, `s.waitRun()`.
- **Otros accesos:** `s.ws()` (WebSocket), `s.afs([...])` (CLI), `s.mcp()` (cliente MCP).
- **Proceso del servidor:** `s.kill()` y `s.start()` simulan una caída y el reinicio.
