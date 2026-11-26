import { createGh, ghJson, ghReadFile, ghTree, type GhRunner } from '../lib/gh.js';
import { parsePatch, applyCaps } from '../lib/diff.js';
import { parseManifest, defaultManifest } from '../lib/manifest.js';
import { parseLinkedIssue } from '../lib/ticket.js';
import { extractTableRefs, selectMigrationPaths } from '../lib/schema.js';
import { globMatch, truncate } from '../lib/util.js';
import { assembleAgentInstructions, selectAgentInstructionPaths } from '../lib/instructions.js';
import type {
  AgentName,
  ExistingComment,
  Manifest,
  PrInfo,
  ReviewContext,
  SpecFile,
  TicketRef,
} from '../lib/types.js';
import type { ReviewSource } from './source.js';

interface PrView {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  comments?: { author: { login: string }; body: string }[];
}

const SPEC_BUDGET_CHARS = 60_000;
const DOC_BUDGET_CHARS = 40_000;
const FILE_CONTENT_CHARS = 12_000;
const MIGRATION_MAX_FILES = 20;
const MIGRATION_BUDGET_CHARS = 30_000;

export class GitHubSource implements ReviewSource {
  private gh: GhRunner;

  constructor(
    private repo: string,
    private prNumber: number,
    gh?: GhRunner,
  ) {
    this.gh = gh ?? createGh();
  }

  async buildContext(issueFlag?: number): Promise<ReviewContext> {
    const gh = this.gh;
    const view = await ghJson<PrView>(gh, [
      'pr',
      'view',
      String(this.prNumber),
      '--repo',
      this.repo,
      '--json',
      'number,title,body,author,url,headRefName,baseRefName,headRefOid,comments',
    ]);
    const pr: PrInfo = {
      number: view.number,
      title: view.title,
      body: view.body ?? '',
      author: view.author?.login ?? 'unknown',
      url: view.url,
      headRef: view.headRefName,
      baseRef: view.baseRefName,
      headSha: view.headRefOid,
    };

    // Commit list: the author's stated intent per change. Subject lines only —
    // cheap context for the requirements axis and a ticket-resolution hop.
    const commitList = await ghJson<{ oid: string; commit?: { message?: string } }[]>(
      gh,
      ['api', `repos/${this.repo}/pulls/${this.prNumber}/commits`, '--paginate'],
    ).catch(() => [] as { oid: string; commit?: { message?: string } }[]);
    pr.commits = commitList.slice(0, 50).map((c) => ({
      oid: c.oid,
      subject: (c.commit?.message ?? '').split('\n')[0] ?? '',
    }));

    const manifest = await this.loadManifest(pr.headSha);
    const diffText = await gh(['pr', 'diff', String(this.prNumber), '--repo', this.repo]);
    const parsed = parsePatch(diffText);
    const { review, skipped } = applyCaps(parsed, {
      skip: manifest.skip,
      maxFileChangedLines: manifest.maxFileChangedLines,
      maxTotalChangedLines: manifest.maxTotalChangedLines,
    });

    // Full head content for reviewed files (the verifier needs real code).
    const files = await Promise.all(
      review.map(async (f) => {
        let content: string | null = null;
        if (f.status !== 'removed') {
          const raw = await ghReadFile(gh, this.repo, f.path, pr.headSha);
          content = raw ? truncate(raw, FILE_CONTENT_CHARS) : null;
        }
        return { ...f, content };
      }),
    );

    // Ticket: flag > body closing keywords > commit closing keywords > branch.
    // Never a guess.
    const link = parseLinkedIssue({
      prBody: pr.body,
      branch: pr.headRef,
      commits: (pr.commits ?? []).map((c) => c.subject),
      flag: issueFlag,
    });
    let ticket: TicketRef | null = null;
    if (link.number) {
      const issue = await ghJson<{ number: number; title: string; body: string; url: string }>(
        gh,
        ['issue', 'view', String(link.number), '--repo', this.repo, '--json', 'number,title,body,url'],
      ).catch(() => null);
      if (issue) ticket = issue;
    }
    const requirementsVerified = ticket !== null;

    const { comments, threadsTrusted } = await this.loadComments(view, pr);
    const specs = await this.loadSpecs(pr.headSha, manifest);
    const docs = await this.loadDocs(pr.headSha, manifest);
    const agentInstructions = await this.loadAgentInstructions(pr.headSha, manifest);
    const migrations = await this.loadMigrations(pr.headSha, manifest, diffText, review.map((f) => f.path));

    return {
      repo: this.repo,
      prNumber: this.prNumber,
      pr,
      files,
      skipped,
      ticket,
      requirementsVerified,
      ticketSource: ticket ? link.source : 'none',
      specs,
      agentInstructions,
      comments,
      threadsTrusted,
      manifest,
      docs,
      migrations,
      contextTruncated: false,
    };
  }

  private async loadManifest(ref: string): Promise<Manifest> {
    const raw = await ghReadFile(this.gh, this.repo, '.pr-review.json', ref);
    if (!raw) return defaultManifest();
    try {
      return parseManifest(raw);
    } catch {
      return defaultManifest();
    }
  }

  private async loadComments(
    view: PrView,
    pr: PrInfo,
  ): Promise<{ comments: ExistingComment[]; threadsTrusted: boolean }> {
    const comments: ExistingComment[] = (view.comments ?? []).map((c) => ({
      author: c.author?.login ?? 'unknown',
      body: c.body,
    }));

    const reviewComments = await ghJson<
      { id: number; body: string; path: string; line: number | null; user: { login: string } | null }[]
    >(this.gh, ['api', `repos/${this.repo}/pulls/${this.prNumber}/comments`, '--paginate']).catch(() => []);

    for (const rc of reviewComments) {
      comments.push({
        author: rc.user?.login ?? 'unknown',
        body: rc.body,
        file: rc.path,
        line: rc.line ?? undefined,
        commentId: rc.id,
      });
    }

    // Resolution state from GraphQL; if this fails we say so (threadsTrusted=false)
    // rather than pretend we knew which threads were dismissed.
    let threadsTrusted = false;
    const [owner, name] = this.repo.split('/');
    if (owner && name) {
      const gql = await this.gh([
        'api',
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved comments(first:100){nodes{databaseId}}}}}}}',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${pr.number}`,
      ], { allowFail: true }).catch(() => '');
      if (gql) {
        try {
          const data = JSON.parse(gql) as {
            data?: {
              repository?: {
                pullRequest?: {
                  reviewThreads?: {
                    nodes?: { isResolved: boolean; comments?: { nodes?: { databaseId: number }[] } }[];
                  };
                };
              };
            };
          };
          const threads = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
          for (const t of threads) {
            const ids = new Set((t.comments?.nodes ?? []).map((c) => c.databaseId));
            for (const c of comments) {
              if (c.commentId !== undefined && ids.has(c.commentId)) {
                c.resolved = t.isResolved;
                c.threadId = String(c.commentId);
              }
            }
          }
          threadsTrusted = true;
        } catch {
          threadsTrusted = false;
        }
      }
    }
    return { comments, threadsTrusted };
  }

  private async loadSpecs(ref: string, manifest: Manifest): Promise<SpecFile[]> {
    const tree = await ghTree(this.gh, this.repo, ref);
    const paths = tree.filter((p) => manifest.specs.some((g) => globMatch(g, p)));
    const specs: SpecFile[] = [];
    let budget = SPEC_BUDGET_CHARS;
    for (const p of paths) {
      if (budget <= 0) break;
      const content = await ghReadFile(this.gh, this.repo, p, ref);
      if (!content) continue;
      const cut = truncate(content, budget);
      specs.push({ path: p, content: cut });
      budget -= cut.length;
    }
    return specs;
  }

  private async loadAgentInstructions(ref: string, manifest: Manifest): Promise<SpecFile[]> {
    if (manifest.agentInstructions === false) return [];
    // Instruction files sit anywhere in the tree, including nested (.github/,
    // .cursor/rules/, per-package AGENTS.md), so fetch recursively and read the
    // full payload. The shared ghTree helper is root-only and cannot see them;
    // this mirrors skills/heimdall-review/scripts/fetch-context.mjs.
    const tree = await ghJson<{ tree?: { path: string; type: string }[] }>(
      this.gh,
      ['api', `repos/${this.repo}/git/trees/${ref}?recursive=1`],
    )
      .then((d) => (d.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path))
      .catch(() => [] as string[]);
    const paths = selectAgentInstructionPaths(tree, manifest.agentInstructions, manifest.skip);
    return assembleAgentInstructions(paths, (p) => ghReadFile(this.gh, this.repo, p, ref));
  }

  /**
   * Migrations naming tables the diff references — schema facts. A constraint
   * defined outside the diff is what kills a false premise ("this column is
   * not unique") that would otherwise ship as a wrong Major, so the verifier
   * gets these files deterministically and can cite them. Files already in the
   * diff carry full content and are skipped here.
   */
  private async loadMigrations(
    ref: string,
    manifest: Manifest,
    diffText: string,
    inDiffPaths: string[],
  ): Promise<SpecFile[]> {
    const tables = extractTableRefs(diffText);
    if (!tables.length) return [];
    // A recursive tree, like the instruction loader: migration dirs nest deep
    // and the shared ghTree helper is root-only.
    const tree = await ghJson<{ tree?: { path: string; type: string }[] }>(
      this.gh,
      ['api', `repos/${this.repo}/git/trees/${ref}?recursive=1`],
    )
      .then((d) => (d.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path))
      .catch(() => [] as string[]);
    const inDiff = new Set(inDiffPaths);
    const paths = selectMigrationPaths(tree, tables, manifest.migrations, manifest.skip).filter(
      (p) => !inDiff.has(p),
    );
    const migrations: SpecFile[] = [];
    let budget = MIGRATION_BUDGET_CHARS;
    for (const p of paths.slice(0, MIGRATION_MAX_FILES)) {
      if (budget <= 0) break;
      const content = await ghReadFile(this.gh, this.repo, p, ref);
      if (!content) continue;
      const cut = truncate(content, budget);
      migrations.push({ path: p, content: cut });
      budget -= cut.length;
    }
    return migrations;
  }

  private async loadDocs(ref: string, manifest: Manifest): Promise<ReviewContext['docs']> {
    const tree = await ghTree(this.gh, this.repo, ref);
    const docs: ReviewContext['docs'] = [];
    let budget = DOC_BUDGET_CHARS;
    for (const [agent, cfg] of Object.entries(manifest.agents) as [AgentName, Manifest['agents'][AgentName]][]) {
      for (const pattern of cfg.docs) {
        const paths = pattern.includes('*')
          ? tree.filter((p) => globMatch(pattern, p))
          : tree.filter((p) => p === pattern);
        for (const p of paths) {
          if (budget <= 0) break;
          const content = await ghReadFile(this.gh, this.repo, p, ref);
          if (!content) continue;
          const cut = truncate(content, budget);
          docs.push({ agent, path: p, content: cut });
          budget -= cut.length;
        }
      }
    }
    return docs;
  }
}
