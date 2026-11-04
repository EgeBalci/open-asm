import { isOnionHost, ONION_V3_REGEX, torSocksAddr } from './onion';

const ONION = `${'a'.repeat(52)}2345.onion`;

describe('onion', () => {
  it('detects an onion host in a bare host, host:port or URL', () => {
    expect(isOnionHost(ONION)).toBe(true);
    expect(isOnionHost(`${ONION}:80`)).toBe(true);
    expect(isOnionHost(`http://www.${ONION.toUpperCase()}:8080/a?b`)).toBe(true);
    expect(isOnionHost(`${ONION}.`)).toBe(true);
    expect(isOnionHost('example.com')).toBe(false);
    expect(isOnionHost('onion.example.com:443')).toBe(false);
    expect(isOnionHost(`https://example.com/${ONION}`)).toBe(false);
  });

  it('accepts only v3 onion addresses', () => {
    expect(ONION_V3_REGEX.test(ONION)).toBe(true);
    expect(ONION_V3_REGEX.test(`www.${ONION}`)).toBe(true);
    expect(ONION_V3_REGEX.test('expyuzz4wqqyqhjn.onion')).toBe(false); // v2
    expect(ONION_V3_REGEX.test(`${'a'.repeat(55)}1.onion`)).toBe(false);
  });

  it('reads the Tor proxy from TOR_SOCKS_ADDR', () => {
    const saved = process.env.TOR_SOCKS_ADDR;
    delete process.env.TOR_SOCKS_ADDR;
    expect(torSocksAddr()).toBe('oasm-tor:9050');
    process.env.TOR_SOCKS_ADDR = '127.0.0.1:9150';
    expect(torSocksAddr()).toBe('127.0.0.1:9150');
    if (saved === undefined) delete process.env.TOR_SOCKS_ADDR;
    else process.env.TOR_SOCKS_ADDR = saved;
  });
});
