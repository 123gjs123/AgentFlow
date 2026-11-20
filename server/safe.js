/**
 * Shared hardening for code that touches repos and external text.
 * - SAFE_GIT: the config every git call of the app runs with (no pager, no external diff, no fsmonitor program).
 *   Commands that can run a textconv driver (log -S/-G/-p, diff, show, blame, grep) also take NO_TEXTCONV.
 * - untrusted(): wraps text from external systems as data, never instructions.
 */
export const SAFE_GIT = ['-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.fsmonitor=false', '--no-pager'];
export const NO_TEXTCONV = ['--no-textconv', '--no-ext-diff'];
/** The environment for processes the app launches (commands, Claude): without the app's own secrets and data location. */
const HIDDEN_ENV = ['AFS_DATA', 'AFS_TOKEN', 'AFS_TOKEN_FILE', 'AFS_UI_KEY', 'AFS_CRED_KEY_FILE', 'AFS_WORKSPACES', 'PORT', 'HOST', 'INIT_CWD', 'OLDPWD'];
export function childEnv(extra = {}) { const e = { ...process.env }; for (const k of Object.keys(e)) if (HIDDEN_ENV.includes(k) || /^npm_/i.test(k)) delete e[k]; return { ...e, ...extra }; }
export const untrusted = (s) => `<untrusted-data>\n${String(s).replace(/<\/?untrusted-data>/gi, '[etiqueta]')}\n</untrusted-data>`;
