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

## Qué cubre (178 tests)

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
