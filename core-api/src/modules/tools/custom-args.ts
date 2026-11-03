import type { ConnectorManifestEntry } from '../connectors/connector-registry.service';
import { builtInTools } from './tools-provider/built-in-tools';

/** Reserved config-profile key holding the admin-set extra tool arguments. */
export const CUSTOM_ARGS_KEY = 'customArgs';
export const CUSTOM_ARGS_MAX_LENGTH = 1024;

/**
 * Whether the tool honours `customArgs`: a built-in whose command template has
 * an `{{args}}` slot, or a connector whose manifest sets `customArgs: true`.
 */
export function supportsCustomArgs(
  toolName: string,
  entry?: ConnectorManifestEntry | null,
): boolean {
  if (entry) return entry.customArgs === true;
  return !!builtInTools
    .find((t) => t.name === toolName)
    ?.command?.includes('{{args}}');
}

/**
 * Splits a command-line string into argv tokens with POSIX shell quoting:
 * whitespace separates, '…' is literal, "…" honours \" and \\, and a backslash
 * outside quotes escapes the next character. Throws on unbalanced quotes.
 */
export function parseCustomArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (/\s/.test(c)) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
      continue;
    }
    inToken = true;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error('Unterminated single quote');
      cur += input.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      for (i++; ; i++) {
        if (i >= input.length) throw new Error('Unterminated double quote');
        if (input[i] === '"') break;
        if (input[i] === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) i++;
        cur += input[i];
      }
    } else if (c === '\\') {
      if (++i >= input.length) throw new Error('Trailing backslash');
      cur += input[i];
    } else {
      cur += c;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

/** Single-quotes every token so `sh -c` passes it through as one literal argument. */
export function shellQuoteArgs(tokens: string[]): string {
  return tokens.map((t) => `'${t.replace(/'/g, `'\\''`)}'`).join(' ');
}
