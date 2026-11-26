import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parsePatch, applyCaps } from '../lib/diff.js';
import { parseManifest, defaultManifest } from '../lib/manifest.js';
import { parseLinkedIssue } from '../lib/ticket.js';
import type { PrInfo, ReviewContext, SpecFile, TicketRef } from '../lib/types.js';
import type { ReviewSource } from './source.js';

export interface FixtureMeta {
  repo: string;
  pr: PrInfo;
  ticket?: TicketRef | null;
  /** which ticket-source the fixture is exercising */
  ticketSource?: 'body' | 'commit' | 'branch' | 'none';
  manifest?: Partial<import('../lib/types.js').Manifest>;
  comments?: ReviewContext['comments'];
  /** repo agent-instruction files for fixtures that exercise that section */
  agentInstructions?: SpecFile[];
}

export interface FixturePr {
  /** unified git diff text */
  diff: string;
  /** head content per changed file path */
  contents: Record<string, string>;
}

/**
 * Offline context for eval: no gh, no network. Same ReviewContext the GitHub
 * source produces, so eval exercises the real pipeline, not a mock.
 */
export class FixtureSource implements ReviewSource {
  constructor(
    private dir: string,
    private issueFlag?: number,
  ) {}

  async buildContext(): Promise<ReviewContext> {
    const meta = JSON.parse(readFileSync(path.join(this.dir, 'fixture.json'), 'utf8')) as FixtureMeta;
    const fixture = JSON.parse(readFileSync(path.join(this.dir, 'pr.json'), 'utf8')) as FixturePr;

    const manifest = { ...defaultManifest(), ...(meta.manifest ?? {}) };
    const parsed = parsePatch(fixture.diff);
    const { review, skipped } = applyCaps(parsed, {
      skip: manifest.skip,
      maxFileChangedLines: manifest.maxFileChangedLines,
      maxTotalChangedLines: manifest.maxTotalChangedLines,
    });

    const files = review.map((f) => ({
      ...f,
      content: f.status === 'removed' ? null : (fixture.contents[f.path] ?? null),
    }));

    const link = parseLinkedIssue({
      prBody: meta.pr.body,
      branch: meta.pr.headRef,
      flag: this.issueFlag,
    });
    const ticket = meta.ticket ?? null;
    const requirementsVerified = ticket !== null;

    return {
      repo: meta.repo,
      prNumber: meta.pr.number,
      pr: meta.pr,
      files,
      skipped,
      ticket,
      requirementsVerified,
      ticketSource: ticket ? link.source : 'none',
      specs: [],
      agentInstructions: meta.agentInstructions ?? [],
      comments: meta.comments ?? [],
      threadsTrusted: true,
      manifest: parseManifest(JSON.stringify(manifest)),
      docs: [],
      contextTruncated: false,
    };
  }
}
