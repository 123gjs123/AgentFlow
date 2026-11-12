// Trust the operating system's certificate store too (corporate TLS-intercepting proxies install their root there).
// Without it, every HTTPS request the server makes (requirement checks, context pages, integration checks) fails with
// SELF_SIGNED_CERT_IN_CHAIN behind such a proxy. Needs Node 22.15+/23.10+; older Node keeps its bundled CAs.
import tls from 'node:tls';

export function trustSystemCertificates() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return 0;
    const system = tls.getCACertificates('system');
    if (!system.length) return 0;
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system])]);
    return system.length;
  } catch { return 0; }
}
const trusted = trustSystemCertificates();
if (!trusted && typeof tls.getCACertificates !== 'function') {
  console.warn(`⚠ Node ${process.versions.node}: no puede usar los certificados del sistema. Detrás de un proxy corporativo las comprobaciones HTTPS (requisitos, páginas de contexto) fallarán con SELF_SIGNED_CERT_IN_CHAIN. Usa Node 22.15 o superior.`);
}
