import { describe, it, expect } from 'vitest';
import { AGENT_NAMES, type ReviewContext } from '../src/lib/types.js';
import { defaultManifest } from '../src/lib/manifest.js';
import { buildContextPack } from '../src/agents/prompt.js';

// The shared "Repo agent instructions" section: it reaches every specialist,
// sits right after the specs, and is the first thing cut under window pressure
// after the per-agent docs (specs are cut last).

function ctx(): ReviewContext {
  return {
    repo: 'acme/x',
    prNumber: 1,
    pr: {
      number: 1, title: 't', body: 'b', author: 'a', url: 'u',
      headRef: 'h', baseRef: 'm', headSha: 'sha',
    },
    files: [{ path: 'a.js', status: 'added', patch: '+x', content: 'x\n', changedLines: [1], added: 1, removed: 0 }],
    skipped: [], ticket: null, requirementsVerified: false, ticketSource: 'none',
    specs: [{ path: 'docs/rfc/one.md', content: 'the spec body' }],
    agentInstructions: [{ path: 'AGENTS.md', content: 'every exported handler must validate input with zod' }],
    comments: [], threadsTrusted: true,
    manifest: defaultManifest(),
    docs: [{ agent: 'standards', path: 'CONTRIBUTING.md', content: 'a contributor doc' }],
    contextTruncated: false,
  };
}

describe('Repo agent instructions section', () => {
  it('renders for all seven specialists when instructions are present', () => {
    for (const agent of AGENT_NAMES) {
      const pack = buildContextPack(ctx(), agent, 300_000).pack;
      expect(pack).toContain('## Repo agent instructions');
      expect(pack).toContain('every exported handler must validate input with zod');
    }
  });

  it('renders nothing when there are no instructions', () => {
    const c = ctx();
    c.agentInstructions = [];
    const pack = buildContextPack(c, 'standards', 300_000).pack;
    expect(pack).not.toContain('## Repo agent instructions');
  });

  it('sits after the Spec files section', () => {
    const pack = buildContextPack(ctx(), 'standards', 300_000).pack;
    expect(pack.indexOf('## Spec files')).toBeLessThan(pack.indexOf('## Repo agent instructions'));
  });

  it('cuts per-agent docs first while instructions and specs survive', () => {
    const noDocs = ctx();
    noDocs.docs = [];
    const keepChars = buildContextPack(noDocs, 'standards', Number.POSITIVE_INFINITY).pack.length;
    const { pack, truncated } = buildContextPack(ctx(), 'standards', keepChars);
    expect(truncated).toBe(true);
    expect(pack).not.toContain('## Repo docs for your specialty');
    expect(pack).toContain('## Repo agent instructions');
    expect(pack).toContain('## Spec files');
  });

  it('cuts instructions before specs and reports truncation', () => {
    const base = ctx();
    base.docs = [];
    base.agentInstructions = [];
    const specsOnlyChars = buildContextPack(base, 'standards', Number.POSITIVE_INFINITY).pack.length;
    const { pack, truncated } = buildContextPack(ctx(), 'standards', specsOnlyChars);
    expect(truncated).toBe(true);
    expect(pack).not.toContain('## Repo agent instructions');
    expect(pack).toContain('## Spec files'); // specs are cut last, so they survive here
  });

  it('treats a missing agentInstructions field as empty', () => {
    const c = ctx() as Partial<ReviewContext>;
    delete c.agentInstructions;
    expect(buildContextPack(c as ReviewContext, 'standards', 300_000).pack).not.toContain('## Repo agent instructions');
  });
});

// The migrations section: schema facts that reach every specialist, so a
// constraint claim must cite a line there or degrade to a question.
describe('Migrations section (schema facts)', () => {
  const migrations = [
    {
      path: 'db/migrations/0012_create_eligible_member.up.sql',
      content: 'UNIQUE (client_id, mobile_number)',
    },
  ];

  it('renders for all seven specialists with the cite-or-ask instruction', () => {
    for (const agent of AGENT_NAMES) {
      const c = ctx();
      c.migrations = migrations;
      const pack = buildContextPack(c, agent, 300_000).pack;
      expect(pack).toContain('## Migrations for tables this diff touches');
      expect(pack).toContain('UNIQUE (client_id, mobile_number)');
    }
  });

  it('renders nothing when there are no migrations', () => {
    expect(buildContextPack(ctx(), 'security', 300_000).pack).not.toContain('## Migrations for tables');
  });

  it('is cut after per-agent docs but before instructions and specs', () => {
    const noMig = ctx();
    noMig.migrations = [];
    const withoutMigrations = buildContextPack(noMig, 'standards', Number.POSITIVE_INFINITY).pack.length;
    const full = ctx();
    full.migrations = migrations;
    const { pack, truncated } = buildContextPack(full, 'standards', withoutMigrations);
    expect(truncated).toBe(true);
    expect(pack).not.toContain('## Repo docs for your specialty'); // docs go first
    expect(pack).not.toContain('## Migrations for tables'); // migrations go next
    expect(pack).toContain('## Repo agent instructions');
    expect(pack).toContain('## Spec files');
  });
});
