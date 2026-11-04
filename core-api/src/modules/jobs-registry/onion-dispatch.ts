import { CUSTOM_ARGS_KEY, parseCustomArgs } from '../tools/custom-args';

/**
 * Built-in command templates for an onion asset ({{proxy}} = Tor SOCKS
 * host:port). A built-in missing here gets no job for an onion asset:
 * subfinder and dnsx would hand the address to passive sources and public DNS.
 */
export const ONION_COMMANDS: Record<string, string> = {
  // naabu resolves hosts to IPs, so it cannot scan an onion service. A TCP
  // connect through Tor answers instead: curl exits 97 (or 7/28) when Tor
  // could not reach the port, and 0/1/8/52/56 once something answered.
  naabu:
    'for p in 80 443 8080 8443 8000 8888 3000 5000 9000 22 21 25; do (curl -s -o /dev/null -m 60 -x socks5h://{{proxy}} http://{{value}}:$p/; case $? in 0|1|8|52|56) echo {{value}}:$p;; esac) & done; wait',
  // No -asn/-cdn/-ip/-cname (local DNS and lookups) or -tls-grab (dials
  // directly, bypassing the proxy).
  httpx:
    'httpx -duc -u {{value}} -proxy socks5://{{proxy}} -status-code -favicon -title -web-server -irr -tech-detect -location -probe -json -follow-redirects -timeout 30 -threads 10 -silent {{args}}',
  screenshot: 'screenshot {{value}} socks5://{{proxy}}',
};

type Config = Record<string, unknown>;

const PROXY_FLAGS = new Set(['-proxy', '--proxy', '-p']);

/**
 * Strips any proxy flag from customArgs and appends `-proxy <url>`. Resolved
 * connector configs carry customArgs pre-split into argv tokens (what the SDK's
 * connector.CustomArgs decodes); a raw profile string is split the same way.
 */
function withProxyArg(config: Config, url: string): Config {
  const raw = config[CUSTOM_ARGS_KEY];
  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? parseCustomArgs(raw)
      : [];
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const [name, ...value] = tokens[i].split('=');
    if (!PROXY_FLAGS.has(name)) kept.push(tokens[i]);
    else if (value.length === 0) i++; // its value is the next token
  }
  return { ...config, [CUSTOM_ARGS_KEY]: [...kept, '-proxy', url] };
}

// Go clients resolve names through a socks5:// proxy; libcurl and Python
// ones only through socks5h://.
const ONION_CONNECTORS: Record<string, (config: Config, tor: string) => Config> = {
  katana: (c, tor) => ({ ...c, proxy: `socks5://${tor}` }),
  ffuf: (c, tor) => ({ ...c, proxy: `socks5://${tor}` }),
  dirsearch: (c, tor) => ({ ...c, proxy: `socks5h://${tor}` }),
  wpscan: (c, tor) => ({ ...c, proxy: `socks5h://${tor}` }),
  nuclei: (c, tor) => withProxyArg(c, `socks5://${tor}`),
};

/**
 * Connector config for an onion asset's job, forced through Tor, or null when
 * the connector has no Tor-safe mode (it would resolve or dial the address
 * directly, or hand it to a third party) and the job must be skipped.
 */
export function onionConnectorConfig(
  toolName: string,
  config: Config | null | undefined,
  tor: string,
): Config | null {
  const route = ONION_CONNECTORS[toolName];
  return route ? route(config ?? {}, tor) : null;
}
