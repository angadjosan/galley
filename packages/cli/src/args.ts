/**
 * A minimal argument parser.
 *
 * Hand-rolled rather than pulled in: the CLI is the thing agents run, and every
 * dependency in its install path is a way for `npm i -g galley` to fail on
 * someone's laptop at exactly the moment they are deciding whether this product
 * works. The surface is small enough to own.
 */
export interface ParsedArgs {
  readonly command: string;
  readonly subcommand: string | null;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, inline] = splitOnce(arg.slice(2), '=');
      if (inline !== null) {
        flags[name] = inline;
      } else {
        const next = argv[i + 1];
        // `--flag value` versus a boolean `--flag`: a following token that
        // looks like another flag is not this flag's value.
        if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const short of arg.slice(1)) flags[short] = true;
      continue;
    }
    positional.push(arg);
  }

  return {
    command: positional[0] ?? 'help',
    subcommand: positional[1] ?? null,
    positional: positional.slice(1),
    flags,
  };
}

function splitOnce(text: string, separator: string): [string, string | null] {
  const index = text.indexOf(separator);
  if (index < 0) return [text, null];
  return [text.slice(0, index), text.slice(index + 1)];
}

export function flagString(args: ParsedArgs, name: string, fallback?: string): string {
  const value = args.flags[name];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags[name];
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got ${value}`);
  return parsed;
}

/** Split `path#block` into its parts. */
export function parseRef(ref: string): { path: string; blockId: string | null } {
  const hash = ref.lastIndexOf('#');
  if (hash < 0) return { path: ref, blockId: null };
  return { path: ref.slice(0, hash), blockId: ref.slice(hash + 1) };
}
