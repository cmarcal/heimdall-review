#!/usr/bin/env node
import { Command } from 'commander';
import { loadEnvFile } from './lib/env.js';
import { runReview } from './lib/orchestrator.js';
import { GitHubSource } from './sources/github.js';
import { runDoctor, describeScoring } from './doctor.js';
import { runEval } from './eval.js';

loadEnvFile();

const program = new Command();

program
  .name('heimdall')
  .description(
    'Multi-agent GitHub PR review that shows its evidence.\n' +
      '7 specialists + a consolidator. Every finding must quote real code or the harness deletes it.\n' +
      'Dry-run by default: nothing is posted unless you pass --post.',
  )
  .version('0.1.0');

program
  .command('review <pr>')
  .description('Review a pull request by number.')
  .requiredOption('--repo <owner/name>', 'GitHub repository')
  .option('--preset <name>', 'override the model preset (anthropic | openrouter | ollama-local)')
  .option('--issue <n>', 'force the linked GitHub issue number')
  .option('--post', 'POST the review to GitHub (default: dry-run, prints only)', false)
  .option('--teach', 'explain the findings that scored low: what the code does, why it breaks, how to fix it', false)
  .option('--teach-below <pct>', 'teaching bar as a 0-100 percentage of the maximum score (implies --teach)')
  .action(async (pr: string, o: ReviewFlags) => {
    const teachBelow = parseTeachBelow(o.teachBelow);
    const source = new GitHubSource(o.repo, Number(pr));
    const res = await runReview({
      source,
      preset: o.preset,
      post: o.post,
      issueFlag: o.issue ? Number(o.issue) : undefined,
      teach: o.teach || teachBelow !== undefined,
      teachBelow,
    });
    process.stdout.write(res.report + '\n');
    if (!o.post) {
      process.stdout.write('\n(dry-run — pass --post to publish. Run artifact already saved under runs/.)\n');
    } else if (res.posted) {
      process.stdout.write(
        `\nposted: ${res.posted.inlineUrls.length} inline, ${res.posted.threadReplies.length} thread replies, summary ${res.posted.updatedSummary ? 'updated' : 'created'}\n`,
      );
    }
  });

interface ReviewFlags {
  repo: string;
  preset?: string;
  issue?: string;
  post: boolean;
  teach: boolean;
  teachBelow?: string;
}

/**
 * The teaching bar is a percentage of the maximum score. A value the harness
 * could not use is a typo, so stop instead of reviewing at a surprise threshold.
 */
function parseTeachBelow(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const pct = Number(value);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    process.stderr.write(
      '--teach-below wants a whole number from 0 to 100: the teaching bar as a percentage of the maximum score.\n',
    );
    process.exit(2);
  }
  return pct;
}

program
  .command('doctor')
  .description('Probe the configured models: is the declared capability honest?')
  .option('--preset <name>', 'preset to probe')
  .option('--scoring', 'print the private scoring map instead', false)
  .action(async (o: { preset?: string; scoring: boolean }) => {
    if (o.scoring) {
      describeScoring();
      return;
    }
    await runDoctor(o.preset);
  });

program
  .command('eval')
  .description('Run the eval fixtures — precision/recall per specialist, no posting.')
  .option('--fixture <name>', 'run one fixture by directory name')
  .option('--live', 'use the real configured model (needs a key); default is offline/scripted', false)
  .option('--preset <name>', 'preset for live mode')
  .option('--teach', 'run every fixture in teach mode: findings and scores must not move', false)
  .option('--teach-below <pct>', 'teaching bar as a 0-100 percentage of the maximum score (implies --teach)')
  .action(async (o: { fixture?: string; live: boolean; preset?: string; teach: boolean; teachBelow?: string }) => {
    const teachBelow = parseTeachBelow(o.teachBelow);
    const code = await runEval({
      fixture: o.fixture,
      mode: o.live ? 'live' : 'offline',
      preset: o.preset,
      teach: o.teach || teachBelow !== undefined,
      teachBelow,
    });
    process.exit(code);
  });

program.parseAsync(process.argv);
