/** A v3 onion service address; Tor ignores labels in front of it. */
export const ONION_V3_REGEX = /^(?:[a-z0-9-]+\.)*[a-z2-7]{56}\.onion$/i;

/**
 * Whether a host, `host:port` or URL names an onion service. Such a value must
 * only ever leave through Tor: no DNS lookup, no passive source, no direct dial.
 */
export function isOnionHost(value: string): boolean {
  const host = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/:?#]/)[0];
  return host.toLowerCase().replace(/\.$/, '').endsWith('.onion');
}

/**
 * host:port of the Tor SOCKS proxy that workers and connectors reach (the
 * compose `tor` service on the oasm-connectors network by default).
 */
export function torSocksAddr(): string {
  return process.env.TOR_SOCKS_ADDR?.trim() || 'oasm-tor:9050';
}
