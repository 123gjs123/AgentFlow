// Ready-made step templates and access presets so configuring a step takes one click.
const READ = 'Read Grep Glob WebFetch WebSearch Skill';
const RA = 'mcp__claude_ai_Atlassian_Rovo';

export const ACCESS = [
  { id: 'read', label: 'Solo lectura', desc: 'Lee archivos del proyecto, busca en la web y usa skills. No modifica nada.', tools: READ, perm: '' },
  { id: 'atlassian-read', label: 'Leer Jira / Confluence', desc: 'Lo anterior + leer tickets, JQL y páginas (MCP Atlassian de tu suscripción).', tools: `${READ} ${RA}__getAccessibleAtlassianResources ${RA}__getJiraIssue ${RA}__searchJiraIssuesUsingJql ${RA}__getConfluencePage ${RA}__searchConfluenceUsingCql ${RA}__search ${RA}__fetch`, perm: '' },
  { id: 'atlassian', label: 'Leer y escribir en Jira / Confluence', desc: 'Puede comentar, crear issues/páginas y transicionar. Úsalo en steps de publicación.', tools: `${READ} ${RA}`, perm: '' },
  { id: 'edit', label: 'Editar archivos', desc: 'Lectura + crear/editar archivos en el directorio del flujo (sin terminal).', tools: `${READ} Edit Write`, perm: 'acceptEdits' },
  { id: 'dev', label: 'Editar + terminal', desc: 'Lectura, edición y comandos (Bash). Para automatizar y correr tests.', tools: `${READ} Edit Write Bash`, perm: 'acceptEdits' },
  { id: 'none', label: 'Sin herramientas', desc: 'Solo razona con el input que recibe. Lo más rápido y barato.', tools: '', perm: '' },
];
const norm = (s) => String(s || '').split(/[\s,]+/).filter(Boolean).sort().join(' ');
export function accessOf(step) {
  return ACCESS.find((a) => norm(a.tools) === norm(step.allowedTools) && (a.perm || '') === (step.permissionMode || '')) || null;
}
const acc = (id) => { const a = ACCESS.find((x) => x.id === id); return { allowedTools: a.tools, permissionMode: a.perm }; };

export const PRESETS = [
  { group: 'Entender', icon: '🎫', name: 'Leer ticket de Jira', desc: 'Trae el ticket y resume objetivo, criterios, reglas y riesgos.',
    step: { kind: 'role', role: 'Eres un QA analista senior: preciso, detectas ambigüedades y riesgos.', task: 'Lee en Jira el ticket {{vars.issue}} (o el indicado en el input), incluyendo descripción, criterios de aceptación y comentarios. Devuelve: objetivo, criterios de aceptación, reglas de negocio, riesgos y preguntas abiertas.', ...acc('atlassian-read') } },
  { group: 'Entender', icon: '📝', name: 'Analizar requerimiento', desc: 'A partir de texto libre: reglas, riesgos y dudas.',
    step: { kind: 'role', role: 'Eres un QA analista senior.', task: 'Analiza el requerimiento del input y lista: objetivo, reglas de negocio, casos borde, riesgos y preguntas abiertas.', ...acc('none') } },
  { group: 'Entender', icon: '🔎', name: 'Revisar cambios del repo', desc: 'Lee el git diff del directorio del flujo y resume impacto.',
    step: { kind: 'role', role: 'Eres un revisor de código senior.', task: 'Revisa los cambios recientes del repositorio (git diff / últimos commits) y resume: qué cambió, impacto funcional, riesgos y qué habría que probar.', allowedTools: `${READ} Bash(git diff*) Bash(git log*) Bash(git status*)`, permissionMode: '' } },
  { group: 'Diseñar', icon: '🧪', name: 'Diseñar casos de prueba', desc: 'Skill qa-test-architect: casos priorizados por riesgo.',
    step: { kind: 'skill', skillRef: 'qa-test-architect', task: 'Con la información de los steps anteriores, diseña casos de prueba priorizados por riesgo en Gherkin breve, indicando técnica y nivel.', ...acc('read') } },
  { group: 'Diseñar', icon: '🛡️', name: 'Revisión adversarial', desc: 'Skill qa-adversarial: huecos, negativos y falsa confianza.',
    step: { kind: 'skill', skillRef: 'qa-adversarial', task: 'Critica lo producido por los steps anteriores: huecos de cobertura, aserciones débiles, negativos y bordes faltantes. Devuelve la lista priorizada de mejoras.', ...acc('read') } },
  { group: 'Construir', icon: '🤖', name: 'Escribir automatización', desc: 'Skill qa-automation: genera/edita tests en el repo.',
    step: { kind: 'skill', skillRef: 'qa-automation', task: 'Implementa en el repositorio los casos aprobados como tests automatizados siguiendo las convenciones existentes. Resume los archivos creados/modificados.', ...acc('dev') } },
  { group: 'Construir', icon: '▶️', name: 'Correr tests', desc: 'Comando de shell; su salida pasa al siguiente step.',
    step: { kind: 'command', command: 'npx playwright test --reporter=line', shell: 'powershell' } },
  { group: 'Publicar', icon: '💬', name: 'Comentar en Jira', desc: 'Resume lo anterior y lo comenta en el ticket.',
    step: { kind: 'role', role: 'Redactas comentarios de QA claros y breves.', task: 'Agrega un comentario en el ticket {{vars.issue}} con un resumen accionable de las salidas de los steps anteriores (máx. 15 líneas, con viñetas).', allowedTools: `${READ} ${RA}__getAccessibleAtlassianResources ${RA}__getJiraIssue ${RA}__addCommentToJiraIssue`, permissionMode: '' } },
  { group: 'Publicar', icon: '🐞', name: 'Crear bug en Jira', desc: 'Crea el bug con repro, evidencia y Environment.',
    step: { kind: 'role', role: 'Eres un QA que reporta bugs reproducibles y con evidencia.', task: 'Si las salidas anteriores muestran un defecto, crea un Bug en el proyecto {{vars.project}} con: título claro, pasos de reproducción, resultado esperado vs actual, evidencia y el campo Environment completo (ej. "QA, PPD"). Si no hay defecto, no crees nada y dilo.', ...acc('atlassian') } },
  { group: 'Publicar', icon: '📄', name: 'Publicar en Confluence', desc: 'Crea una página con el resultado del flujo.',
    step: { kind: 'role', role: 'Redactas documentación técnica clara.', task: 'Crea una página en Confluence en el espacio {{vars.space}} con el resultado de los steps anteriores, con título descriptivo y fecha.', allowedTools: `${READ} ${RA}__getAccessibleAtlassianResources ${RA}__getConfluenceSpaces ${RA}__createConfluencePage`, permissionMode: '' } },
  { group: 'En blanco', icon: '🎭', name: 'Rol vacío', desc: 'Defines quién es y qué hace.', step: { kind: 'role', ...acc('read') } },
  { group: 'En blanco', icon: '🤖', name: 'Agente vacío', desc: 'Usa un agente de Claude Code.', step: { kind: 'agent', ...acc('read') } },
  { group: 'En blanco', icon: '🧩', name: 'Skill vacía', desc: 'Usa una de tus skills.', step: { kind: 'skill', ...acc('read') } },
  { group: 'En blanco', icon: '⌨️', name: 'Comando vacío', desc: 'PowerShell / bash / cmd.', step: { kind: 'command', shell: 'powershell' } },
];
