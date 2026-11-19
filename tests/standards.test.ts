import { describe, it, expect } from 'vitest';
import { AGENT_NAMES, type ReviewContext } from '../src/lib/types.js';
import { defaultManifest, parseManifest } from '../src/lib/manifest.js';
import { buildContextPack, pass1System } from '../src/agents/prompt.js';

// The standards axis (imported from the two-axis code-review design): the
// seventh specialist, the auto-discovered repo-standards docs, and the
// commits-as-intent context section.

describe('standards specialist (seventh axis)', () => {
  it('is a first-class agent everywhere agents are enumerated', () => {
    expect(AGENT_NAMES).toContain('standards');
    expect(defaultManifest().agents.standards.enabled).toBe(true);
  });

  it('its prompt loads and carries the three binding rules', () => {
    const sys = pass1System('standards');
    expect(sys).toContain('Standards specialist');
    expect(sys).toContain('Feature Envy'); // the smell baseline is pasted in full
    expect(sys).toContain('The repo overrides');
    expect(sys).toContain('judgement call');
    expect(sys).toContain('Skip what tooling enforces');
  });

  it('auto-discovers the classic standards docs with no manifest present', () => {
    const docs = defaultManifest().agents.standards.docs;
    expect(docs).toEqual(
      expect.arrayContaining(['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'AGENTS.md', 'CLAUDE.md']),
    );
  });

  it('an explicit empty docs list suppresses discovery', () => {
    const m = parseManifest(JSON.stringify({ agents: { standards: { docs: [] } } }));
    expect(m.agents.standards.docs).toEqual([]);
    // other agents keep their (empty) defaults untouched
    expect(m.agents.security.docs).toEqual([]);
  });

  it('a manifest can replace standards discovery', () => {
    const m = parseManifest(JSON.stringify({ agents: { standards: { docs: ['STYLE.md'] } } }));
    expect(m.agents.standards.docs).toEqual(['STYLE.md']);
  });
});

describe('commits as stated intent', () => {
  function ctx(): ReviewContext {
    return {
      repo: 'acme/x',
      prNumber: 1,
      pr: {
        number: 1, title: 't', body: 'b', author: 'a', url: 'u',
        headRef: 'h', baseRef: 'm', headSha: 'sha',
      },
      files: [{ path: 'a.js', status: 'added', patch: '', content: 'x\n', changedLines: [1], added: 1, removed: 0 }],
      skipped: [], ticket: null, requirementsVerified: false, ticketSource: 'none',
      specs: [], comments: [], threadsTrusted: true, manifest: defaultManifest(), docs: [], contextTruncated: false,
    };
  }

  it('renders the commit subjects in the pack when the source provided them', () => {
    const c = ctx();
    c.pr.commits = [
      { oid: 'aaa', subject: 'feat: persist the device anchor' },
      { oid: 'bbb', subject: 'test: cover anchor fallback' },
    ];
    const pack = buildContextPack(c, 'requirements', 300_000).pack;
    expect(pack).toContain('## Commits');
    expect(pack).toContain('- feat: persist the device anchor');
    expect(pack).toContain('- test: cover anchor fallback');
  });

  it('omits the section entirely when commits are unavailable', () => {
    const pack = buildContextPack(ctx(), 'requirements', 300_000).pack;
    expect(pack).not.toContain('## Commits');
  });
});
