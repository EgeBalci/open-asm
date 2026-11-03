import { execFileSync } from 'child_process';

import {
  parseCustomArgs,
  shellQuoteArgs,
  supportsCustomArgs,
} from './custom-args';
import type { ConnectorManifestEntry } from '../connectors/connector-registry.service';

describe('parseCustomArgs', () => {
  it.each([
    ['', []],
    ['  -sV   --top-ports 10 ', ['-sV', '--top-ports', '10']],
    [`--script 'http-title and safe'`, ['--script', 'http-title and safe']],
    [`-H "X-A: \\"b\\" \\\\ c"`, ['-H', 'X-A: "b" \\ c']],
    [`a\\ b 'c'"d"e`, ['a b', 'cde']],
    [`''`, ['']],
  ])('%j', (input, want) => expect(parseCustomArgs(input)).toEqual(want));

  it.each([`'abc`, `"abc`, `abc\\`])('rejects %j', (input) =>
    expect(() => parseCustomArgs(input)).toThrow(),
  );
});

describe('shellQuoteArgs', () => {
  it('passes every token through sh -c as one literal argument', () => {
    const tokens = ["it's", '$(id)', '; rm -rf /', '`x`', '$HOME', ''];
    const out = execFileSync('sh', [
      '-c',
      `printf '%s\\n' ${shellQuoteArgs(tokens)}`,
    ]).toString();
    expect(out.split('\n').slice(0, -1)).toEqual(tokens);
  });
});

describe('supportsCustomArgs', () => {
  it('follows the {{args}} slot for built-ins', () => {
    expect(supportsCustomArgs('naabu')).toBe(true);
    expect(supportsCustomArgs('screenshot')).toBe(false);
  });

  it('follows the manifest flag for connectors', () => {
    const entry = { slug: 'nmap' } as ConnectorManifestEntry;
    expect(supportsCustomArgs('nmap', entry)).toBe(false);
    expect(supportsCustomArgs('nmap', { ...entry, customArgs: true })).toBe(
      true,
    );
  });
});
