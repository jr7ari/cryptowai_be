import { readFileSync, existsSync } from 'node:fs';

/**
 * Minimal Java-style .properties parser (supports `key=value`, `key: value`, `key value`,
 * `#`/`!` comments, `\` line continuations, `\uXXXX` and standard escapes, and `${ENV_VAR:default}`
 * placeholders resolved from the environment).
 */
export function parseProperties(text: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const rawLines = text.split(/\r?\n/);
  const logical: string[] = [];
  let buf = '';
  for (const raw of rawLines) {
    const line = buf ? raw.replace(/^\s+/, '') : raw;
    let bs = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) bs++;
    if (bs % 2 === 1) {
      buf += line.slice(0, -1);
      continue;
    }
    logical.push(buf + line);
    buf = '';
  }
  if (buf) logical.push(buf);

  for (const l of logical) {
    const line = l.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let i = 0;
    let key = '';
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\' && i + 1 < line.length) {
        key += line[i + 1];
        i += 2;
        continue;
      }
      if (ch === '=' || ch === ':' || /\s/.test(ch)) break;
      key += ch;
      i++;
    }
    while (i < line.length && /\s/.test(line[i])) i++;
    if (line[i] === '=' || line[i] === ':') i++;
    while (i < line.length && /\s/.test(line[i])) i++;
    const value = unescape(line.slice(i));
    out[key] = resolvePlaceholders(value, env);
  }
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.startsWith('u') && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c;
  });
}

function resolvePlaceholders(v: string, env: NodeJS.ProcessEnv): string {
  return v.replace(/\$\{([A-Za-z0-9_.]+)(?::([^}]*))?\}/g, (_, name: string, def?: string) => env[name] ?? def ?? '');
}

export function loadPropertiesFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseProperties(readFileSync(path, 'utf8'));
}

/** Keys that must NEVER come from a properties file (secrets live in env/secret manager only). */
const SECRET_KEY_PATTERN = /(secret|password|passwd|api[-_.]?key|token|private[-_.]?key)/i;

export function findSecretKeys(props: Record<string, string>): string[] {
  return Object.keys(props).filter((k) => SECRET_KEY_PATTERN.test(k) && props[k] !== '' && !/\$\{/.test(props[k]));
}
