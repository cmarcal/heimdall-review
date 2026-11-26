import { describe, it, expect } from 'vitest';
import { extractTableRefs, selectMigrationPaths } from '../src/lib/schema.js';
import { MIGRATION_GLOBS } from '../src/lib/manifest.js';
import { globMatch } from '../src/lib/util.js';

// Schema facts: the source pulls in migrations naming tables the diff's SQL
// references, so a constraint claim must cite them or die as a question.
// Extraction and selection are deterministic — no model in the loop.

describe('extractTableRefs', () => {
  it('finds DML tables, splitting schema-qualified names', () => {
    const diff = [
      '+  `SELECT id, customer_name FROM core.orders WHERE id = $1`',
      '+  `UPDATE core.orders SET status = $2`',
      '+  `INSERT INTO queue (id) VALUES ($1)`',
    ].join('\n');
    expect(extractTableRefs(diff)).toEqual(['core', 'orders', 'queue']);
  });

  it('finds DDL targets (create/alter/drop/truncate table)', () => {
    const diff = [
      '+CREATE TABLE IF NOT EXISTS core.queue (id uuid);',
      '+ALTER TABLE orders ADD CONSTRAINT ...;',
      '+TRUNCATE TABLE audit_log;',
    ].join('\n');
    expect(extractTableRefs(diff)).toEqual(['audit_log', 'core', 'orders', 'queue']);
  });

  it('filters syntax noise, aliases and short names', () => {
    expect(extractTableRefs('FROM (SELECT 1) x')).toEqual([]);
    expect(extractTableRefs('FROM unnest(ids)').join()).toBe('');
    expect(extractTableRefs('JOIN m ON m.id = x.id')).not.toContain('m');
  });

  it('deduplicates and lowercases', () => {
    expect(extractTableRefs('FROM Queue q ... FROM queue q2 ... UPDATE QUEUE')).toEqual(['queue']);
  });
});

describe('selectMigrationPaths', () => {
  const tree = [
    'db/migrations/0007_create_orders.up.sql',
    'db/migrations/0013_create_audit.up.sql',
    'db/post_deployment_migrations/0042_backfill_queue_partial_concurrency_key.up.sql',
    'src/migrations/20240101_add_feature_flags.sql',
    'db/seeds/orders_seed.sql',
    'README.md',
  ];

  it('keeps only migration-glob files whose path names a referenced table', () => {
    expect(selectMigrationPaths(tree, ['orders', 'queue'], MIGRATION_GLOBS, [])).toEqual([
      'db/migrations/0007_create_orders.up.sql',
      'db/post_deployment_migrations/0042_backfill_queue_partial_concurrency_key.up.sql',
    ]);
  });

  it('returns nothing when the diff references no tables', () => {
    expect(selectMigrationPaths(tree, [], MIGRATION_GLOBS, [])).toEqual([]);
  });

  it('ignores paths outside the migration globs even on a name hit', () => {
    expect(selectMigrationPaths(tree, ['orders'], MIGRATION_GLOBS, [])).not.toContain(
      'db/seeds/orders_seed.sql',
    );
  });

  it('honours skip globs', () => {
    const skip = ['**/post_deployment_migrations/**'];
    expect(selectMigrationPaths(tree, ['orders', 'queue'], MIGRATION_GLOBS, skip)).toEqual([
      'db/migrations/0007_create_orders.up.sql',
    ]);
  });

  it('the default globs cover nested and plural-layout migration dirs', () => {
    for (const p of [
      'db/migrations/x.sql',
      'db/post_deployment_migrations/y.sql',
      'prisma/migrations/z/migration.sql',
      'db/migrate/3.sql',
    ]) {
      expect(MIGRATION_GLOBS.some((g) => globMatch(g, p))).toBe(true);
    }
    expect(MIGRATION_GLOBS.some((g) => globMatch(g, 'src/db/orders.ts'))).toBe(false);
  });
});
