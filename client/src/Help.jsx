import React, { useEffect, useLayoutEffect, useState } from 'react';
import { api } from './api.js';
import { PRESETS } from './presets.js';
import IntegrationWizard from './Integrations.jsx';

// ---------------- modal shell ----------------
export function Modal({ title, onClose, children, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head"><b>{title}</b><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------- step picker (templates) ----------------
export function StepPicker({ catalog, onPick, onClose }) {
  const groups = [...new Set(PRESETS.map((p) => p.group))];
  const hasSkill = (n) => catalog.skills.some((s) => s.name === n);
  // Reusable boxes saved with “📚 Guardar” (spec 18)
  const [lib, setLib] = useState([]);
  useEffect(() => { api.get('/api/library').then(setLib).catch(() => {}); }, []);
  const KIND_ICON = { role: '🎭', agent: '🤖', skill: '🧩', command: '⌨️' };
  return (
    <Modal title="Agregar step" onClose={onClose} wide>
      <p className="muted small">Elige una plantilla: queda configurada (tipo, tarea, accesos) y luego ajustas lo que quieras. Si tienes un step seleccionado, el nuevo se conecta después de él.</p>
      {lib.length > 0 && (
        <div className="preset-group">
          <div className="preset-title">📚 Mis steps</div>
          <div className="preset-grid">
            {lib.map((it) => (
              <div key={it.id} className="lib-item">
                <button className="preset" onClick={() => onPick({ group: 'Mis steps', name: it.name, step: { ...it.step, name: it.name } })}>
                  <span className="preset-icon">{KIND_ICON[it.kind] || '•'}</span>
                  <span><b>{it.name}</b><span className="muted small">{it.step.skillRef || it.step.agentRef || (it.step.task || it.step.command || '').slice(0, 80)}</span></span>
                </button>
                <button className="ghost small danger" title="Quitar de Mis steps" onClick={async () => { await api.del(`/api/library/${it.id}`); setLib((l) => l.filter((x) => x.id !== it.id)); }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g} className="preset-group">
          <div className="preset-title">{g}</div>
          <div className="preset-grid">
            {PRESETS.filter((p) => p.group === g).map((p) => (
              <button key={p.name} className="preset" onClick={() => onPick(p)}>
                <span className="preset-icon">{p.icon}</span>
                <span><b>{p.name}</b><span className="muted small">{p.desc}</span>
                  {p.step.skillRef && !hasSkill(p.step.skillRef) && <span className="warn-text small">skill “{p.step.skillRef}” no encontrada</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

// ---------------- create with AI ----------------
export function AiFlowModal({ onClose, onCreated, cwd }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const examples = [
    'Dado un ticket de Jira: leerlo, diseñar casos con qa-test-architect, revisarlos con qa-adversarial y comentar el resultado en el ticket.',
    'Cada mañana: buscar bugs abiertos de SBK con prioridad alta, agruparlos por equipo y publicar un resumen en Confluence.',
    'Analizar el git diff del repo, decidir qué tests correr, ejecutarlos con npx playwright y si fallan crear un bug en Jira.',
  ];
  async function go() {
    setBusy(true); setErr('');
    try { const f = await api.post('/api/flows/generate', { description: text, cwd }); onCreated(f); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  return (
    <Modal title="✨ Crear flujo describiéndolo" onClose={onClose}>
      <p className="muted small">Cuéntalo como se lo contarías a un colega. Claude (Sonnet, con tu suscripción) arma los steps usando tus skills y agentes, con accesos mínimos. Después lo revisas y ajustas.</p>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Quiero un flujo que…" autoFocus />
      <div className="chips">{examples.map((e) => <button key={e} className="chip btn" onClick={() => setText(e)}>{e.slice(0, 60)}…</button>)}</div>
      {err && <div className="error-bar">{err}</div>}
      <div className="row end"><button className="ghost" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy || text.trim().length < 10} onClick={go}>{busy ? <><span className="spinner" /> Generando…</> : 'Crear flujo'}</button></div>
    </Modal>
  );
}

// ---------------- external invocation ----------------
function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="copy">
      <pre className="mono small">{text}</pre>
      <button className="ghost small" onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); try { localStorage.setItem('afs.didExternal', '1'); } catch {} }}>{ok ? '✓' : 'Copiar'}</button>
    </div>
  );
}

export function ExternalInvoke({ flow }) {
  const [info, setInfo] = useState(null);
  const [show, setShow] = useState(false);
  const [tab, setTab] = useState('claude');
  useEffect(() => { api.get('/api/info').then(setInfo); }, []);
  if (!info) return <div className="muted small pad">Cargando…</div>;
  const base = `http://127.0.0.1:${info.port}`;
  const name = flow?.name || 'Mi flujo';
  const tok = show ? info.token : '<TOKEN>';
  const enc = encodeURIComponent(name);
  const cli = `node "${info.cli}"`;
  const snippets = {
    claude: {
      label: 'Claude Code (MCP)',
      intro: 'Registra el servidor MCP una vez. Desde cualquier sesión de Claude Code (o un agente) puedes decir “ejecuta el flujo X con input Y”: Claude usa las tools run_flow / ask_flow / list_flows. Si la app no está corriendo, el MCP la arranca.',
      code: [`claude mcp add agent-flows -s user -- "${info.node}" "${info.mcp}"`, `# luego, en Claude Code:\n> ejecuta el flujo "${name}" con input SBK-123`],
    },
    cli: {
      label: 'Terminal (afs)',
      intro: 'CLI para scripts y terminal. Muestra el progreso por step y deja el resultado final en stdout (código de salida 1 si falla). Con `npm link` en la carpeta del proyecto queda el comando global `afs`.',
      code: [`${cli} list`, `${cli} run "${name}" -i "SBK-123"`, `${cli} run "${name}" --var issue=SBK-123 --json`, `${cli} ask "${name}" "¿qué riesgos encontró el último análisis?"`],
    },
    http: {
      label: 'HTTP / API',
      intro: 'API REST con token. wait=true espera el resultado (sync); sin wait devuelve runId y consultas el estado.',
      code: [
        `curl -X POST "${base}/api/ext/flows/${enc}/run" -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" -d "{\\"input\\":\\"SBK-123\\",\\"wait\\":true}"`,
        `curl "${base}/api/ext/flows/${enc}/runs/<runId>" -H "Authorization: Bearer ${tok}"`,
        `curl -X POST "${base}/api/ext/flows/${enc}/ask" -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" -d "{\\"message\\":\\"resume el último resultado\\"}"`,
      ],
    },
    ps: {
      label: 'PowerShell',
      intro: 'Igual que HTTP, desde PowerShell o un script programado.',
      code: [`$h = @{ Authorization = "Bearer ${tok}" }\n$r = Invoke-RestMethod -Method Post -Uri "${base}/api/ext/flows/${enc}/run" -Headers $h -ContentType "application/json" -Body (@{ input = "SBK-123"; wait = $true } | ConvertTo-Json)\n$r.result`],
    },
    jenkins: {
      label: 'Jenkins / CI',
      intro: 'Si el agente de Jenkins corre en esta máquina, usa la CLI; el exit code hace fallar el stage. Si corre en otra máquina, mira “Desde otra máquina”.',
      code: [`stage('Agent flow') {\n  steps {\n    bat 'node "${info.cli}" run "${name}" --var build=%BUILD_NUMBER% -i "%GIT_COMMIT%"'\n  }\n}`],
    },
    webhook: {
      label: 'Webhook',
      intro: 'Para herramientas que solo envían un POST (Bitbucket, Jira Automation, etc.): el token va en la URL y todo el JSON recibido llega como input del flujo.',
      code: [`${base}/api/ext/flows/${enc}/run?token=${tok}&source=webhook`],
    },
    remote: {
      label: 'Desde otra máquina',
      intro: 'Por seguridad la app solo escucha en esta PC. Para llamadas remotas (Bitbucket Cloud, Jenkins en otro host) arráncala con HOST=0.0.0.0: solo /api/ext queda expuesto y siempre exige token; la UI sigue siendo local. Revisa el firewall y no la expongas a internet sin un proxy/VPN.',
      code: ['$env:HOST = "0.0.0.0"; npm start', `curl -X POST "http://<IP-de-esta-PC>:${info.port}/api/ext/flows/${enc}/run" -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" -d "{\\"input\\":\\"...\\"}"`],
    },
  };
  const s = snippets[tab];
  return (
    <div className="ext">
      {flow ? <IntegrationWizard flow={flow} /> : <p className="muted small">Abre un flujo para usar el asistente de integración.</p>}
      <details className="advanced"><summary>Snippets rápidos y token</summary>
      <div className="row wrap">
        <span className="small"><b>Token:</b> <code>{show ? info.token : '••••••••••••'}</code></span>
        <button className="ghost small" onClick={() => setShow(!show)}>{show ? 'ocultar' : 'mostrar en snippets'}</button>
        <button className="ghost small" onClick={() => navigator.clipboard.writeText(info.token)}>copiar</button>
        <button className="ghost small danger" onClick={async () => { if (confirm('¿Regenerar el token? Lo que use el anterior dejará de funcionar.')) { const r = await api.post('/api/info/rotate-token'); setInfo({ ...info, token: r.token }); } }}>regenerar</button>
      </div>
      <div className="seg">{Object.entries(snippets).map(([k, v]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{v.label}</button>)}</div>
      <p className="small">{s.intro}</p>
      {s.code.map((c, i) => <Copy key={i} text={c} />)}
      <p className="muted small">El flujo se identifica por <b>nombre</b> o id (<code>{flow?.id}</code>). Las ejecuciones externas aparecen en Ejecuciones con su origen (api, cli, mcp, webhook).</p>
      </details>
    </div>
  );
}

// ---------------- help menu + guide ----------------
const SECTIONS = [
  ['start', 'Primeros pasos'], ['concepts', 'Conceptos'], ['config', 'Configurar un step'], ['vars', 'Variables y plantillas'], ['arrows', 'Flechas, ramas y breaks'],
  ['access', 'Accesos y permisos'], ['chats', 'Chats y memoria'], ['hooks', 'Hooks (código)'], ['external', 'Invocar desde fuera'], ['faq', 'Problemas comunes'],
];

export function HelpMenu({ onTour, onGuide }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="run-wrap" data-tour="help">
      <button className="ghost" onClick={() => setOpen(!open)} title="Ayuda">❔ Ayuda</button>
      {open && (
        <div className="popover menu" onMouseLeave={() => setOpen(false)}>
          <button className="ghost" onClick={() => { setOpen(false); onTour(); }}>🧭 Recorrido guiado</button>
          {SECTIONS.map(([k, l]) => <button key={k} className="ghost" onClick={() => { setOpen(false); onGuide(k); }}>{l}</button>)}
        </div>
      )}
    </div>
  );
}

function Checklist({ flow, flows }) {
  const didExt = (() => { try { return localStorage.getItem('afs.didExternal') === '1'; } catch { return false; } })();
  const items = [
    ['Crear un flujo (vacío, demo o ✨ con IA)', flows.length > 0],
    ['Agregar al menos 2 steps desde una plantilla', (flow?.steps.length || 0) >= 2],
    ['Conectarlos (arrastra del punto derecho al izquierdo)', (flow?.edges.length || 0) > 0],
    ['Ejecutar el flujo y mirar la pestaña Actividad', !!flow?.steps.some((s) => s.lastRun)],
    ['Chatear con un step o con el chat general', !!(flow?.globalSessionId || flow?.steps.some((s) => s.chatSessionId))],
    ['Guardar algo en memoria (o pedir “recuerda que…”)', !!(flow?.memory?.length || flow?.steps.some((s) => s.memory?.length))],
    ['Invocarlo desde fuera (copiar un snippet)', didExt],
  ];
  const done = items.filter((i) => i[1]).length;
  return (
    <div className="checklist">
      <div className="progress"><div style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <div className="small muted">{done}/{items.length} completados{flow ? ` en “${flow.name}”` : ''}</div>
      <ul>{items.map(([t, ok]) => <li key={t} className={ok ? 'ok' : ''}>{ok ? '✅' : '⬜'} {t}</li>)}</ul>
    </div>
  );
}

export function HelpModal({ section, setSection, onClose, flow, flows, onTour }) {
  return (
    <Modal title="Ayuda" onClose={onClose} wide>
      <div className="help">
        <nav>{SECTIONS.map(([k, l]) => <button key={k} className={`ghost ${section === k ? 'active' : ''}`} onClick={() => setSection(k)}>{l}</button>)}</nav>
        <div className="help-body">
          {section === 'start' && (<>
            <h3>Primeros pasos</h3>
            <p>Agent Flow Studio arma <b>flujos de agentes</b>: cajas (steps) conectadas, donde la salida de cada una alimenta a las siguientes. Todo corre con <b>tu Claude Code</b>: tu suscripción, tus skills, agentes y conectores (Jira/Confluence vía Atlassian Rovo).</p>
            <Checklist flow={flow} flows={flows} />
            <button className="primary" onClick={onTour}>🧭 Hacer el recorrido guiado</button>
          </>)}
          {section === 'concepts' && (<>
            <h3>Conceptos</h3>
            <ul>
              <li><b>Flujo</b>: un conjunto de steps y relaciones, con variables, memoria general y directorio de trabajo.</li>
              <li><b>Step</b>: una caja. Tipos: 🎭 <b>Rol</b> (tú defines quién es), 🤖 <b>Agente</b> (de ~/.claude/agents), 🧩 <b>Skill</b> (tus skills), ⌨️ <b>Comando</b> (shell).</li>
              <li><b>Relación</b>: “la salida de A entra en B”. Las dibujas tú; el <b>orden</b> (número en cada caja) y el acomodo se calculan solos. Steps del mismo número corren en paralelo.</li>
              <li><b>Ejecución</b>: corre los steps en orden. Si uno falla, los que dependen de él se omiten.</li>
            </ul>
          </>)}
          {section === 'config' && (<>
            <h3>Configurar un step</h3>
            <ol>
              <li>Agrégalo con <b>+ Step</b> y elige una plantilla (ya trae tarea y accesos).</li>
              <li><b>¿Qué hace?</b> (tarea): lo que debe producir en cada ejecución. Sé concreto con el formato de salida.</li>
              <li><b>¿Cómo trabaja?</b> (rol): personalidad/criterio. En steps de skill o agente es opcional.</li>
              <li><b>Acceso</b>: elige un nivel (solo lectura, Jira, editar…). Empieza por el mínimo.</li>
              <li><b>Avanzado</b> (opcional): contexto fijo, modelo (Haiku = rápido/barato, Opus = más capaz), effort y tools exactas.</li>
            </ol>
            <p className="muted">Truco: abre el <b>Chat</b> del step y pídele “mejora tu tarea para que…”. Te propone el cambio y lo aplicas con un botón.</p>
          </>)}
          {section === 'arrows' && (<>
            <h3>Flechas, ramas y breaks</h3>
            <p><b>Conectar desde cualquier lado.</b> Cada caja tiene puntos en sus 4 lados: los <b>rellenos</b> son salidas y los <b>huecos</b> entradas. Arrastra de una salida a una entrada. Para cambiar el lado de una flecha ya hecha, arrastra su extremo a otro punto.</p>
            <p><b>Una caja, muchas flechas.</b> Una caja puede recibir de varias y enviar a varias. Haz click en una flecha para decidir:</p>
            <ul>
              <li><b>Qué pasa</b>: toda la salida, o solo un campo del JSON (p. ej. <code>casos</code> a una caja y <code>riesgos</code> a otra).</li>
              <li><b>Cuándo pasa</b>: siempre, si un campo del JSON cumple algo (<code>riesgo = alto</code>), si la salida contiene un texto o cumple una regex, o <b>🧭 lo decide el step de origen</b>: el agente o rol ve la lista de destinos y elige con <code>&lt;route to="Destino"/&gt;</code>, o le manda a cada uno algo distinto con <code>&lt;route to="Destino"&gt;contenido&lt;/route&gt;</code>.</li>
              <li><b>Etiqueta</b>: se ve sobre la flecha y el destino la recibe como título.</li>
            </ul>
            <p>Si ninguna flecha de entrada de una caja pasa, esa caja queda <b>no enrutada</b>: no corre, no es un error, y tampoco corre lo que depende solo de ella. Las flechas con condición se ven punteadas.</p>
            <p><b>Reutilizar cajas.</b> <i>Duplicar</i> copia la caja en el mismo flujo. <i>📚 Guardar</i> la deja en <b>Mis steps</b>; desde <b>＋ Step</b> la insertas configurada en cualquier flujo. Se copia la configuración, no la memoria ni las ejecuciones.</p>
            <p><b>Breaks (⏸).</b> En <i>Config → Break</i> eliges pausar <b>antes</b> o <b>después</b> de la caja. Al ejecutar, el flujo se detiene y se abre <b>Revisar</b>:</p>
            <ul>
              <li><b>Después</b>: ves la salida (texto y JSON) y eliges entre <i>Aprobar y seguir</i>, <i>Editar salida</i> (los siguientes reciben tu versión), <i>Re-ejecutar con corrección</i> (vuelve a correr con tu indicación y se pausa otra vez) o <i>Detener</i>.</li>
              <li><b>Antes</b>: ves lo que va a recibir y eliges entre <i>Ejecutar y seguir</i>, <i>Omitir este step</i> o <i>Detener</i>.</li>
            </ul>
            <p>Mientras está en pausa no corre el tiempo máximo de la ejecución. Las ejecuciones externas ignoran los breaks salvo que pidan <code>breakpoints: true</code> (API), <code>--breaks</code> (afs) o <code>breakpoints</code> (MCP). Después siguen con <code>/resume</code>, <code>afs resume</code> o <code>resume_run</code>.</p>
          </>)}
          {section === 'vars' && (<>
            <h3>Variables y plantillas</h3>
            <ul>
              <li><code>{'{{input}}'}</code>: el input con el que se ejecutó el flujo.</li>
              <li><code>{'{{vars.issue}}'}</code>: variables del flujo (pestaña Flujo → Variables, JSON). Desde fuera: <code>--var issue=SBK-1</code> o <code>{'"vars":{"issue":"SBK-1"}'}</code>.</li>
              <li><code>{'{{steps.Nombre.output}}'}</code>: última salida de otro step.</li>
              <li>Cada step recibe automáticamente las salidas de los steps conectados antes que él.</li>
            </ul>
          </>)}
          {section === 'access' && (<>
            <h3>Accesos y permisos</h3>
            <p>Un step solo puede usar las herramientas de su <b>Acceso</b>. Si intenta otra, se deniega y lo verás en Actividad (“Permisos denegados: …”).</p>
            <ul>
              <li><b>Solo lectura</b>: archivos, web y skills. Ideal para analizar y diseñar.</li>
              <li><b>Leer / escribir Jira-Confluence</b>: usa el MCP Atlassian de tu suscripción. Escritura solo en steps de publicación.</li>
              <li><b>Editar / Editar + terminal</b>: para automatizar en el repo (directorio de trabajo del flujo).</li>
            </ul>
            <p className="muted">“↻ detectar tools/MCPs” en Avanzado lista lo que tu Claude Code tiene conectado, sin gastar una llamada al modelo.</p>
          </>)}
          {section === 'chats' && (<>
            <h3>Chats y memoria</h3>
            <ul>
              <li><b>Chat del step</b>: conversa con ese agente/skill/rol con su contexto (config, última ejecución, memoria). Mantiene su sesión. “Modo mejora” le permite editar la skill/agente.</li>
              <li><b>Chat general</b> (click en el fondo del canvas): hablas libre; un enrutador elige qué step responde o si ejecuta algo, y te muestra por qué.</li>
              <li><b>Proceso interno</b>: en cada respuesta ves razonamiento, tools usadas, resultados y tokens.</li>
              <li><b>Memoria</b>: hechos duraderos por step y del flujo. Se llenan solos (“recuerda que…”) o a mano; los steps ven memoria relacionada de otros como referencia.</li>
            </ul>
          </>)}
          {section === 'hooks' && (<>
            <h3>Hooks (código)</h3>
            <p>Acciones automáticas en JavaScript por step: <code>onStart</code>, <code>onSuccess</code>, <code>onFailure</code>. Usa los botones de snippets (Jira, Confluence, git, shell). Disponibles: <code>ctx.sh</code>, <code>ctx.ai(prompt, {'{ tools }'})</code>, <code>ctx.runStep</code>, <code>ctx.remember</code>, <code>ctx.setVar</code>, <code>ctx.log</code>.</p>
          </>)}
          {section === 'external' && (<>
            <h3>Invocar desde fuera</h3>
            <p>Puedes disparar o consultar este flujo desde Jira, Jenkins, GitHub/Bitbucket/GitLab, scripts, la terminal u otro agente (MCP).</p>
            <ul className="small">
              <li><b>Asistente de integración.</b> Elige quién llama y describe cuándo: te genero el código o la regla listos para pegar. "Adaptar con IA" lo ajusta a tu descripción y un control revisa todo lo que genera (sin token escrito, solo llamadas a esta app, nada de comandos peligrosos).</li>
              <li><b>¿Llega la llamada?</b> Si quien llama corre en esta PC, usa 127.0.0.1 y no expones nada. Si está en tu red, la app tiene que escuchar en la red (HOST=0.0.0.0). Los servicios en la nube (Jira Cloud, GitHub, Bitbucket) no llegan a tu PC: usa un runner en esta PC, un túnel que deje pasar solo <code>/api/ext/</code> (pega su URL en "URL pública"), o que el flujo consulte Jira de forma programada.</li>
              <li><b>Token.</b> Nunca va escrito en el código: va en los secretos de quien llama (credencial de Jenkins, secret de GitHub, variable segura de Bitbucket/GitLab, header "Hidden" en Jira o variable de entorno <code>AFS_TOKEN</code>). Si se filtra, regenéralo.</li>
              <li><b>Datos del que llama.</b> Se escriben como <code>{'{BUILD_TAG}'}</code>, <code>{'{GIT_COMMIT}'}</code>…: los reemplaza el script desde las variables de entorno, sin pasar por el shell (comillas o $ no rompen nada ni inyectan comandos). En Jira se usan smart values <code>{'{{issue.key}}'}</code>.</li>
              <li><b>Idempotency-Key.</b> Un id único por evento: si quien llama reintenta con la misma clave no se lanza otra ejecución (si la anterior falló, sí).</li>
              <li><b>Probar.</b> "Probar (sin ejecutar)" valida flujo, step, variables y token sin crear nada ni gastar. En terminal: <code>afs run "&lt;flujo&gt;" --dry-run</code>. Abajo verás cuándo llega la primera llamada real (un 401 = llegó sin token válido).</li>
            </ul>
            <ExternalInvoke flow={flow} />
          </>)}
          {section === 'faq' && (<>
            <h3>Problemas comunes</h3>
            <ul>
              <li><b>“Permisos denegados”</b>: sube el nivel de Acceso del step (o agrega la tool en Avanzado).</li>
              <li><b>Un MCP aparece en amarillo</b>: necesita login/autorización en claude.ai → Connectors, o con <code>/mcp</code> en Claude Code.</li>
              <li><b>El step agente/skill “no encontrado”</b>: revisa que exista en ~/.claude o en el directorio del flujo.</li>
              <li><b>Es lento/caro</b>: usa Haiku o effort low en steps simples, y acceso “Sin herramientas” cuando solo razona.</li>
              <li><b>401 desde fuera</b>: falta el token o se regeneró.</li>
              <li><b>Uso de la suscripción</b>: el indicador “5h / 7d” arriba a la derecha muestra el consumo.</li>
            </ul>
          </>)}
        </div>
      </div>
    </Modal>
  );
}

// ---------------- guided tour ----------------
export const TOUR = [
  { sel: null, title: 'Bienvenido 👋', body: 'Aquí armas flujos de agentes de IA que corren con tu Claude Code (tu suscripción, skills, agentes y MCPs). Te muestro lo esencial en 1 minuto.' },
  { sel: '[data-tour="flows"]', title: 'Tus flujos', body: 'Crea uno vacío, el demo de QA, o ✨ descríbelo con palabras y la IA lo arma con tus skills.' },
  { sel: '[data-tour="add-step"]', title: 'Agregar steps', body: 'Cada caja es un step: rol, agente, skill o comando. Elige una plantilla y queda casi lista. Si hay un step seleccionado, el nuevo se conecta después.' },
  { sel: '[data-tour="canvas"]', title: 'Relaciones y orden', body: 'Arrastra del punto derecho de un step al izquierdo de otro: su salida pasa al siguiente. El número de cada caja es el orden de ejecución, calculado solo. Supr borra lo seleccionado.' },
  { sel: '[data-tour="side"]', title: 'Panel lateral', body: 'Click en un step → Config, Chat, Actividad, Memoria y Hooks de ese step. Click en el fondo → chat general, ajustes del flujo, memoria y ejecuciones.' },
  { sel: '[data-tour="side"]', title: 'Chat con contexto', body: 'El chat del step responde dentro de su rol/skill y su última ejecución, propone mejoras aplicables con un botón y guarda memoria. El chat general decide solo a qué step preguntar.' },
  { sel: '[data-tour="run"]', title: 'Ejecutar', body: 'Ejecuta el flujo con un input (ticket, texto, URL…). Verás cada step en vivo en el canvas y su proceso interno (razonamiento, tools, resultados) en Actividad.' },
  { sel: '[data-tour="rate"]', title: 'Tu suscripción', body: 'Consumo de tus ventanas de 5 horas y 7 días.' },
  { sel: '[data-tour="help"]', title: 'Ayuda e invocación externa', body: 'Aquí está la guía, la lista de primeros pasos y “Invocar desde fuera”: Claude Code (MCP), terminal, API, Jenkins y webhooks.' },
];

export function Tour({ step, setStep, onClose }) {
  const s = TOUR[step];
  const [rect, setRect] = useState(null);
  const next = () => (step < TOUR.length - 1 ? setStep(step + 1) : onClose());
  useLayoutEffect(() => {
    const el = s?.sel ? document.querySelector(s.sel) : null;
    const upd = () => setRect(el ? el.getBoundingClientRect() : null);
    upd();
    window.addEventListener('resize', upd);
    return () => window.removeEventListener('resize', upd);
  }, [step]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft' && step) setStep(step - 1); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });
  if (!s) return null;
  const pad = 6;
  const W = 340;
  let pos = { left: window.innerWidth / 2 - W / 2, top: window.innerHeight / 2 - 100 };
  if (rect) {
    const below = rect.bottom + 12 + 180 < window.innerHeight;
    pos = { left: Math.min(Math.max(12, rect.left + rect.width / 2 - W / 2), window.innerWidth - W - 12), top: below ? rect.bottom + 12 : Math.max(12, rect.top - 192) };
    if (rect.height > window.innerHeight * 0.6) pos = { left: rect.left > W + 24 ? rect.left - W - 16 : Math.min(rect.right + 16, window.innerWidth - W - 12), top: 120 };
  }
  return (
    <div className="tour">
      {rect ? <div className="tour-hole" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} /> : <div className="tour-dim" />}
      <div className="tour-card" style={{ ...pos, width: W }}>
        <div className="small muted">{step + 1} / {TOUR.length}</div>
        <h4>{s.title}</h4>
        <p>{s.body}</p>
        <div className="row end">
          <button className="ghost small" onClick={onClose}>Saltar</button>
          {step > 0 && <button className="ghost" onClick={() => setStep(step - 1)}>←</button>}
          <button className="primary" onClick={next}>{step < TOUR.length - 1 ? 'Siguiente →' : 'Listo'}</button>
        </div>
      </div>
    </div>
  );
}
