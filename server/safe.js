/**
 * Shared hardening for code that touches repos and external text.
 * - SAFE_GIT: the config every git call of the app runs with (no pager, no external diff, no fsmonitor program).
 *   Commands that can run a textconv driver (log -S/-G/-p, diff, show, blame, grep) also take NO_TEXTCONV.
 * - untrusted(): wraps text from external systems as data, never instructions.
 */
export const SAFE_GIT = ['-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.fsmonitor=false', '--no-pager'];
export const NO_TEXTCONV = ['--no-textconv', '--no-ext-diff'];
export const untrusted = (s) => `<untrusted-data>\n${String(s).replace(/<\/?untrusted-data>/gi, '[etiqueta]')}\n</untrusted-data>`;
