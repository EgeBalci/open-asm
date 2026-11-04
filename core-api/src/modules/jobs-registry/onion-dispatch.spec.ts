import { ONION_COMMANDS, onionConnectorConfig } from './onion-dispatch';

const TOR = 'oasm-tor:9050';

describe('onionConnectorConfig', () => {
  it('sets the proxy field with the scheme the client resolves remotely', () => {
    expect(onionConnectorConfig('katana', { depth: 2 }, TOR)).toEqual({
      depth: 2,
      proxy: 'socks5://oasm-tor:9050',
    });
    // A profile proxy is replaced, never kept next to Tor.
    expect(
      onionConnectorConfig('wpscan', { proxy: 'http://192.0.2.1:8080' }, TOR),
    ).toEqual({ proxy: 'socks5h://oasm-tor:9050' });
  });

  it('replaces any nuclei proxy flag in customArgs with Tor, as argv tokens', () => {
    const tor = ['-proxy', 'socks5://oasm-tor:9050'];
    // Resolved configs carry customArgs already tokenized (resolveConfigForJob).
    expect(
      onionConnectorConfig(
        'nuclei',
        {
          customArgs: ['-x', '1', '-p', 'http://192.0.2.1:8080', '--proxy=a', '-proxy', 'b'],
          severity: ['high'],
        },
        TOR,
      ),
    ).toEqual({ customArgs: ['-x', '1', ...tor], severity: ['high'] });
    // A raw profile string is split the same way.
    expect(
      onionConnectorConfig('nuclei', { customArgs: `-proxy "http://192.0.2.1:1"` }, TOR),
    ).toEqual({ customArgs: tor });
    expect(onionConnectorConfig('nuclei', null, TOR)).toEqual({ customArgs: tor });
  });

  it('skips connectors with no Tor-safe mode', () => {
    for (const name of ['nmap', 'rustscan', 'gau', 'nikto', 'acunetix', 'zap']) {
      expect(onionConnectorConfig(name, {}, TOR)).toBeNull();
    }
  });

  it('never runs subfinder against an onion service', () => {
    expect(ONION_COMMANDS.subfinder).toBeUndefined();
    for (const command of Object.values(ONION_COMMANDS)) {
      expect(command).toContain('{{proxy}}');
    }
  });
});
