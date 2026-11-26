export type Tier = 'blocker' | 'major' | 'minor' | 'nit';
export type Capability = 'high' | 'standard' | 'basic';
export type AgentName =
  | 'security'
  | 'requirements'
  | 'e2e-tests'
  | 'architecture'
  | 'regression'
  | 'performance'
  | 'standards';

export const AGENT_NAMES: AgentName[] = [
  'security',
  'requirements',
  'e2e-tests',
  'architecture',
  'regression',
  'performance',
  'standards',
];

export type AgentRole = AgentName | 'verifier' | 'consolidator' | 'gap-check';

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  patch: string;
  /** full file content at head, null if removed or fetch failed */
  content: string | null;
  changedLines: number[];
  added: number;
  removed: number;
}

export interface PrCommit {
  oid: string;
  /** first line of the commit message — the author's stated intent */
  subject: string;
}

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  /** commit list when the source could fetch it — intent context for reviewers */
  commits?: PrCommit[];
}

export interface ExistingComment {
  author: string;
  body: string;
  /** set when it is an inline review comment */
  file?: string;
  line?: number;
  /** GraphQL thread id, when available */
  threadId?: string;
  /** REST review comment id — reply target */
  commentId?: number;
  resolved?: boolean;
}

export interface TicketRef {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface SpecFile {
  path: string;
  content: string;
}

export interface Manifest {
  preset: string | null;
  budgetUsd: number;
  maxFileChangedLines: number;
  maxTotalChangedLines: number;
  skip: string[];
  specs: string[];
  /**
   * Glob patterns for the repo's own AI-tool instruction files (AGENTS.md,
   * CLAUDE.md, Cursor rules, ...). `false` turns detection off.
   */
  agentInstructions: string[] | false;
  /**
   * Glob patterns for migration directories. When the diff references SQL
   * tables, migrations naming those tables are fetched as schema facts so a
   * constraint claim must cite them or downgrade to a question.
   */
  migrations: string[];
  /**
   * Optional teaching bar for this repo, as a percentage of the maximum score:
   * `--teach` explains the findings scoring below it. Only `below` is read;
   * the score map itself stays the harness's.
   */
  teach?: { below: number };
  agents: Record<AgentName, { enabled: boolean; docs: string[] }>;
}

export interface ReviewContext {
  repo: string;
  prNumber: number;
  pr: PrInfo;
  files: DiffFile[];
  skipped: { file: string; reason: string }[];
  ticket: TicketRef | null;
  requirementsVerified: boolean;
  ticketSource: 'flag' | 'body' | 'commit' | 'branch' | 'none';
  specs: SpecFile[];
  /** the repo's own AI-tool instruction files (AGENTS.md, Cursor rules, ...) */
  agentInstructions: SpecFile[];
  comments: ExistingComment[];
  threadsTrusted: boolean;
  manifest: Manifest;
  /** repo docs declared in the manifest, keyed by agent */
  docs: { agent: AgentName; path: string; content: string }[];
  /** migrations naming tables the diff references — schema facts, not diff files */
  migrations?: SpecFile[];
  /** true when the context pack had to be truncated for the model window */
  contextTruncated: boolean;
}

export interface AgentResult {
  agent: AgentName;
  status: 'done' | 'partial' | 'failed';
  findings: VerifiedFinding[];
  /** candidates dropped by the second pass — proof the verifier works */
  dropped: number;
  model: string;
  capability: Capability;
  note?: string;
}

export interface VerifiedFinding {
  findingId: string;
  agent: AgentName;
  mergedAgents: string[];
  file: string;
  line: number;
  title: string;
  verifiedEvidence: string;
  why: string;
  suggestion: string;
  status: 'keep' | 'question';
  impact: number;
  certainty: number;
  blastRadius: number;
  score: number;
  tier: Tier;
}

export interface GapCheckResult {
  file: string;
  clean: boolean;
  note?: string;
}

export interface CoverageRow {
  agent: string;
  status: string;
  model: string;
  capability: Capability;
  findings: number;
  dropped: number;
}

export interface RunSummary {
  verdict: string;
  /** PR readiness 0-100 (headline); null when nothing was reviewed */
  prScore: number | null;
  prBand: string | null;
  counts: Record<Tier, number>;
  coverage: CoverageRow[];
  gaps: GapCheckResult[];
  notReviewed: { file: string; reason: string }[];
  requirementsVerified: boolean;
  usedBasicModel: boolean;
  contextTruncated: boolean;
  modelsUsed: { role: string; model: string; capability: Capability }[];
  budgetUsd: number;
  spentUsd: number;
}
