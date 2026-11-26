import { globMatch } from './util.js';

/**
 * Schema facts for the review context. A false "this column is not unique"
 * Major costs more credibility than a dozen Minors earn, and it usually comes
 * from trusting query cardinality over the database: a `:many` lookup is not
 * proof the column is non-unique — the constraint may live in a migration the
 * diff never touched. So the source pulls those migrations in deterministically
 * (no LLM in the loop) and the prompts make a constraint claim cite them or
 * die as a question.
 */

/** Words that follow FROM/JOIN/UPDATE/etc. but are never the table we want. */
const SQL_NOISE = new Set([
  'select',
  'set',
  'values',
  'unnest',
  'lateral',
  'only',
  'exists',
  'rows',
  'range',
  'generate_series',
  'jsonb_array_elements',
  'jsonb_each',
  'regexp_split_to_table',
  'table',
  'index',
  'if',
  'not',
  'final',
  'public',
]);

const TABLE_REF_RE =
  /\b(?:from|join|into|update)\s+(?:if\s+(?:not\s+)?exists\s+)?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*){0,2})/gi;
const DDL_TABLE_RE =
  /\b(?:create|drop|alter|truncate)\s+(?:\w+\s+)*?table\s+(?:if\s+(?:not\s+)?exists\s+)?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*){0,2})/gi;

/**
 * Table names referenced by SQL text (a diff, a query file). Schema-qualified
 * names contribute every dot-segment, so `core.orders` yields both
 * `core` and `orders`. Lowercased, deduped, sorted; syntax noise filtered.
 */
export function extractTableRefs(text: string): string[] {
  const names = new Set<string>();
  for (const re of [TABLE_REF_RE, DDL_TABLE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const qualified = m[1];
      if (!qualified) continue;
      for (const part of qualified.toLowerCase().split('.')) {
        if (part.length < 3) continue;
        if (!/^[a-z_][a-z0-9_]*$/.test(part)) continue;
        if (SQL_NOISE.has(part)) continue;
        names.add(part);
      }
    }
  }
  return [...names].sort();
}

/**
 * Migration files that name a table the diff references. Selection is by file
 * path only (directory matches the migration globs, filename contains a table
 * name) — deterministic and fetch-cheap. Over-inclusion is acceptable (related
 * schema docs the verifier can also cite); the caller caps count and chars.
 */
export function selectMigrationPaths(
  treePaths: string[],
  tables: string[],
  migrationGlobs: string[],
  skipGlobs: string[],
): string[] {
  if (!tables.length) return [];
  return treePaths
    .filter((p) => migrationGlobs.some((g) => globMatch(g, p)))
    .filter((p) => !skipGlobs.some((g) => globMatch(g, p)))
    .filter((p) => {
      const lc = p.toLowerCase();
      return tables.some((t) => lc.includes(t));
    })
    .sort();
}
