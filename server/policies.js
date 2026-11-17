// 📜 Policies (spec 28): the team's unwritten rules, written once and enforced. A policy is NOT memory (MEM-7): memory is
// text for one flow's prompts; a policy is a rule the app checks (review) and, where it can, enforces when running.
// Scopes: 'machine' (this installation: every flow; config.json `policies`) and 'flow' (travels with the definition).
// Honesty rule (adversarial review): each type says what the app GUARANTEES and what it does NOT.
import * as store from './store.js';

export const POLICY_TYPES = {
  noExternalWrites: {
    label: 'No escribir en sistemas externos sin pedido explícito',
    params: [],
    guarantee: 'En los steps de IA bloquea las herramientas MCP de escritura que el step tiene permitidas (crear, editar, transicionar, comentar…) y, como comando directo, `git push` y `curl` con -X POST/PUT/PATCH/DELETE, -d, --data o --json.',
    notGuaranteed: 'No cubre variantes (git -C … push, Invoke-RestMethod en PowerShell, scripts que el agente escriba y ejecute), las herramientas propias de un step de Agente ni los steps de comando: la revisión marca los que detecta para que los revises.',
  },
  defaultEnv: {
    label: 'Ambiente por defecto',
    params: ['var', 'value'],
    guarantee: 'Si la variable está vacía al ejecutar, se usa este valor; los steps reciben la regla en sus instrucciones.',
    notGuaranteed: 'Un step que arme URLs o hosts sin usar la variable puede ignorarla: la revisión lo señala si lo detecta.',
  },
  noCoAuthorTrailer: {
    label: 'Commits y PRs sin "Co-Authored-By" ni menciones a IA',
    params: [],
    guarantee: 'Claude Code corre con la atribución desactivada (sin trailer en commits ni firma en PRs).',
    notGuaranteed: 'Un mensaje de commit escrito a mano por el agente podría mencionarlo: la regla va en sus instrucciones.',
  },
  gitAuthor: {
    label: 'Autor de los commits',
    params: ['name', 'email'],
    guarantee: 'Steps de IA y de comando corren con GIT_AUTHOR_* y GIT_COMMITTER_* fijados a este autor.',
    notGuaranteed: 'Commits hechos fuera de la app no cambian.',
  },
  ticketStatus: {
    label: 'Estado requerido del ticket que dispara el flujo',
    params: ['statuses'],
    guarantee: 'La revisión exige un paso que lo compruebe y frene el flujo (una regla en el prompt no frena nada).',
    notGuaranteed: 'La app no conoce tu sistema de tickets: el control lo hace un step del flujo.',
  },
  noParallelRuns: {
    label: 'Nunca dos ejecuciones a la vez de este flujo (ambientes compartidos)',
    params: [],
    guarantee: 'Una ejecución nueva se rechaza (409) mientras otra del mismo flujo está en curso, venga de donde venga.',
    notGuaranteed: 'Otros flujos o personas que usen el mismo ambiente no están cubiertos.',
  },
  note: {
    label: 'Regla o lección (texto)',
    params: [],
    guarantee: 'Se agrega a las instrucciones de todos los steps de IA y la usan los revisores.',
    notGuaranteed: 'Es texto: el modelo puede no cumplirla. Si se puede verificar, usa otro tipo.',
  },
};
export const SCOPES = ['machine', 'flow'];

const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: 'BAD_POLICY' });
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/** Validates and normalizes one policy (throws 400). */
export function cleanPolicy(p, scope) {
  if (!p || typeof p !== 'object') throw bad('Política inválida');
  const type = String(p.type || '');
  const def = POLICY_TYPES[type];
  if (!def) throw bad(`Tipo de política desconocido: ${type || '(vacío)'}`);
  const params = {};
  for (const k of def.params) {
    const v = str(p.params?.[k], 300);
    if (!v) throw bad(`La política "${def.label}" necesita "${k}"`);
    params[k] = v;
  }
  if (type === 'defaultEnv' && !/^[\w.-]{1,60}$/.test(params.var)) throw bad('"var" debe ser un nombre de variable válido');
  if (type === 'gitAuthor' && !/^[^\s@]+@[^\s@]+$/.test(params.email)) throw bad('"email" no es un email válido');
  const text = str(p.text, 600) || (type === 'note' ? '' : def.label);
  if (!text) throw bad('Escribe la regla');
  return {
    id: typeof p.id === 'string' && /^po_[\w-]{4,40}$/.test(p.id) ? p.id : store.uid('po_'),
    scope: SCOPES.includes(scope || p.scope) ? (scope || p.scope) : 'flow',
    type, text, params,
    enabled: p.enabled !== false,
    source: ['user', 'review', 'import'].includes(p.source) ? p.source : 'user',
    at: Number(p.at) || Date.now(),
  };
}
export function cleanPolicies(list, scope) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw bad('"policies" debe ser una lista');
  return list.slice(0, 50).map((p) => cleanPolicy(p, scope));
}

export const machinePolicies = () => (Array.isArray(store.getConfig().policies) ? store.getConfig().policies : []);
export function setMachinePolicies(list) {
  const clean = cleanPolicies(list, 'machine') || [];
  store.setConfig({ policies: clean });
  return clean;
}
/** Enabled policies that apply to a flow: this installation's + the flow's own. */
export const effective = (flow) => [...machinePolicies(), ...(Array.isArray(flow?.policies) ? flow.policies : [])].filter((p) => p && p.enabled !== false && POLICY_TYPES[p.type]);
export const has = (flow, type) => effective(flow).find((p) => p.type === type) || null;

// Known write tools of the Atlassian connector (granted as a whole server, they cannot be told apart by name prefix).
const ATLASSIAN_WRITES = ['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue', 'addWorklogToJiraIssue', 'createIssueLink', 'createConfluencePage', 'updateConfluencePage', 'createConfluenceFooterComment', 'createConfluenceInlineComment', 'createCompassComponent', 'createCompassComponentRelationship', 'createCompassCustomFieldDefinition'];
export const MCP_WRITE_RE = /^mcp__.*__(create|edit|update|add|transition|delete|remove|set|write|post|send|upload|move|assign|link|share|trash|copy|merge|close|comment)/i;
export const BASH_WRITES = ['Bash(git push:*)', 'Bash(curl -X POST:*)', 'Bash(curl -X PUT:*)', 'Bash(curl -X PATCH:*)', 'Bash(curl -X DELETE:*)', 'Bash(curl --request POST:*)', 'Bash(curl --request PUT:*)', 'Bash(curl --request PATCH:*)', 'Bash(curl --request DELETE:*)', 'Bash(curl -d:*)', 'Bash(curl --data:*)', 'Bash(curl --json:*)'];
const tokens = (list) => String(list || '').match(/[^\s,()]+(?:\([^)]*\))?/g) || [];

/** What the app enforces when a step of this flow runs (engine.executeStep). */
export function runtimeFor(flow, step) {
  const pol = effective(flow);
  const out = { disallowed: [], settings: null, env: {}, notes: [] };
  for (const p of pol) {
    if (p.type === 'noExternalWrites') {
      for (const t of tokens(step.allowedTools)) {
        if (MCP_WRITE_RE.test(t)) out.disallowed.push(t);
        // a whole server granted ("mcp__claude_ai_Atlassian_Rovo"): its write tools cannot be told apart by name
        else if (t.startsWith('mcp__') && t.slice(5).split('__').length === 1 && /atlassian/i.test(t)) for (const w of ATLASSIAN_WRITES) out.disallowed.push(`${t}__${w}`);
      }
      out.disallowed.push(...BASH_WRITES);
    }
    if (p.type === 'noCoAuthorTrailer') out.settings = { ...(out.settings || {}), includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } };
    if (p.type === 'gitAuthor') Object.assign(out.env, { GIT_AUTHOR_NAME: p.params.name, GIT_AUTHOR_EMAIL: p.params.email, GIT_COMMITTER_NAME: p.params.name, GIT_COMMITTER_EMAIL: p.params.email });
    out.notes.push(p.type === 'defaultEnv' ? `${p.text} (variable "${p.params.var}" = "${p.params.value}" salvo que el ticket o la persona digan otra cosa)` : p.type === 'ticketStatus' ? `${p.text}: ${p.params.statuses}. Si el ticket no está en ese estado, dilo al principio y no sigas como si lo estuviera.` : p.text);
  }
  out.disallowed = [...new Set(out.disallowed)];
  return out;
}
/** Env for command steps (only what makes sense outside Claude). */
export const commandEnv = (flow) => runtimeFor(flow, { allowedTools: '' }).env;
/** Variables with the policy defaults applied (an empty or missing variable takes the default). */
export function withDefaults(flow, vars) {
  const v = { ...(vars || {}) };
  for (const p of effective(flow)) if (p.type === 'defaultEnv' && !String(v[p.params.var] ?? '').trim()) v[p.params.var] = p.params.value;
  return v;
}
/** The guarantee text of a policy, for the UI ("garantizado en X, no garantizado en Y"). */
export const describe = (p) => ({ ...p, label: POLICY_TYPES[p.type]?.label, guarantee: POLICY_TYPES[p.type]?.guarantee, notGuaranteed: POLICY_TYPES[p.type]?.notGuaranteed });
