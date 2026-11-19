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
  .action(async (pr: string, o: { repo: string; preset?: string; issue?: string; post: boolean }) => {
    const source = new GitHubSource(o.repo, Number(pr));
    const res = await runReview({
      source,
      preset: o.preset,
      post: o.post,
      issueFlag: o.issue ? Number(o.issue) : undefined,
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
  .action(async (o: { fixture?: string; live: boolean; preset?: string }) => {
    const code = await runEval({ fixture: o.fixture, mode: o.live ? 'live' : 'offline', preset: o.preset });
    process.exit(code);
  });

program.parseAsync(process.argv);
