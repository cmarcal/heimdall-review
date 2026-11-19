#!/usr/bin/env node
/**
 * Safe publisher for the heimdall-review skill. Posts: one review with
 * event=COMMENT, or event=REQUEST_CHANGES when a blocker survived (never
 * approve), replies inside existing human
 * threads when consolidated.json says so, and a summary comment that re-runs
 * UPDATE in place (hidden marker). Self-dedupe: a line bucket this gh user
 * already commented under the heimdall footer is skipped — same marker and
 * bucketing as the CLI, so the two paths never double-post each other's lines.
 * Without --post it prints the plan and changes nothing.
 *
 * Progress lines go to stderr while the run is in flight (stdout stays the single
 * result JSON, so a slow-looking run is never a silent one); the JSON is the only
 * thing on stdout. Each gh call is capped at HEIMDALL_GH_TIMEOUT_MS (default 120s)
 * so a stalled API call fails loudly, on one line, instead of blocking forever.
 *
 * usage: post-review.mjs --dir <workdir> [--post]
 *   <workdir>/consolidated.json  [{findingId,file,line,tier,title,status,mergedAgents,comment,replyTo?}]
 *   <workdir>/summary.md         full summary body (marker added if missing)
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [,, ...argv] = process.argv;
const has = (f) => argv.includes(`--${f}`);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dir = arg('dir');
const POST = has('post');
if (!dir) {
  console.error('usage: post-review.mjs --dir <workdir> [--post]');
  process.exit(1);
}

const MARKER = '<!-- heimdall:summary -->';
const TIERS = {
  blocker: { icon: '💀', label: 'Blocker' },
  major: { icon: '🔴', label: 'Major' },
  minor: { icon: '🟡', label: 'Minor' },
  nit: { icon: '🔵', label: 'Nit' },
};

// Formatting gate — compact mirror of src/lib/format.ts (canonical). The
// prompts ask for brevity and fenced evidence; the publisher enforces it.
const MAX_INLINE_WORDS = 80;
const MAX_TITLE_CHARS = 90;
const FENCE_RE = /^\s*```/;
const CODE_LINE_RE = /^\t[ \t]*\S|^ {4,}\S/;
function tidyComment(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const endPara = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      const opening = !inFence;
      inFence = !inFence;
      if (opening) endPara();
      out.push(line.trim());
      i++;
      continue;
    }
    if (!inFence && CODE_LINE_RE.test(line)) {
      const run = [];
      while (i < lines.length && !FENCE_RE.test(lines[i]) && CODE_LINE_RE.test(lines[i])) run.push(lines[i++]);
      const indent = Math.min(...run.map((l) => (l.match(/^[\t ]*/)?.[0].length ?? 0)));
      endPara();
      out.push('```', ...run.map((l) => l.slice(indent)), '```', '');
      continue;
    }
    out.push(line.trimEnd());
    i++;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function proseWords(text) {
  return (String(text ?? '').replace(/```[\s\S]*?```/g, ' ').match(/\S+/g) ?? []).length;
}
function capTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TITLE_CHARS) return t;
  const cut = t.slice(0, MAX_TITLE_CHARS);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[,;:.!?—-]+$/, '')}…`;
}

// Prose gate — compact mirror of src/lib/prose.ts (canonical). One English on
// GitHub: US spelling, no typos. Curated wrong words only, whole words, prose
// only (fences and `inline code` untouched); every fix is DECLARED, never silent.
const ISE_STEMS = [
  'author', 'categor', 'character', 'custom', 'initial', 'maxim', 'minim',
  'neutral', 'normal', 'optim', 'organ', 'personal', 'prioriti', 'real',
  'recogn', 'sanit', 'serial', 'special', 'standard', 'summar', 'synchron', 'util',
];
const MANUAL_FIXES = {
  behaviour: 'behavior', behaviours: 'behaviors', behavioural: 'behavioral',
  colour: 'color', colours: 'colors', coloured: 'colored',
  favour: 'favor', favours: 'favors', favoured: 'favored',
  labour: 'labor', neighbour: 'neighbor', neighbours: 'neighbors', neighbourhood: 'neighborhood',
  honour: 'honor', honoured: 'honored', flavour: 'flavor',
  centre: 'center', centres: 'centers', centred: 'centered',
  licence: 'license', licenced: 'licensed', defence: 'defense',
  programme: 'program', programmes: 'programs',
  practise: 'practice', practised: 'practiced',
  analyse: 'analyze', analysed: 'analyzed', analysing: 'analyzing',
  amongst: 'among', learnt: 'learned', spelt: 'spelled', dreamt: 'dreamed',
  travelled: 'traveled', travelling: 'traveling', modelling: 'modeling',
  labelled: 'labeled', labelling: 'labeling', judgement: 'judgment',
  enrol: 'enroll', fulfil: 'fulfill', ageing: 'aging',
  recieve: 'receive', recieves: 'receives', recieved: 'received', recieving: 'receiving',
  seperate: 'separate', seperated: 'separated', seperately: 'separately', seperation: 'separation',
  definately: 'definitely', neccessary: 'necessary', nessecary: 'necessary',
  independant: 'independent', independance: 'independence',
  dependancy: 'dependency', dependancies: 'dependencies', dependant: 'dependent',
  compatiblity: 'compatibility', availablity: 'availability',
  vulnerablity: 'vulnerability', maintainance: 'maintenance',
  occured: 'occurred', occurance: 'occurrence', occurances: 'occurrences',
  accomodate: 'accommodate', accomodated: 'accommodated', accomodation: 'accommodation',
  adress: 'address', adressed: 'addressed', adresses: 'addresses',
  succesful: 'successful', sucessful: 'successful',
  succesfully: 'successfully', sucessfully: 'successfully',
  enviroment: 'environment', explicity: 'explicitly', explicitely: 'explicitly',
  imediately: 'immediately', immediatly: 'immediately', persistant: 'persistent',
  refered: 'referred', refering: 'referring', prefered: 'preferred',
  transfered: 'transferred', omited: 'omitted', begining: 'beginning', writting: 'writing',
  teh: 'the', adn: 'and', wiht: 'with', taht: 'that', thier: 'their', whcih: 'which',
  reponse: 'response', reponses: 'responses',
  paramter: 'parameter', paramters: 'parameters',
  paramater: 'parameter', paramaters: 'parameters',
  retrun: 'return', retruns: 'returns',
  implementaion: 'implementation', implemenation: 'implementation',
  resouce: 'resource', resouces: 'resources',
  requierd: 'required', requirment: 'requirement', atribute: 'attribute',
  calender: 'calendar', queryed: 'queried',
};
const PROSE_FIXES = { ...MANUAL_FIXES };
for (const s of ISE_STEMS) {
  PROSE_FIXES[`${s}ise`] = `${s}ize`;
  PROSE_FIXES[`${s}ises`] = `${s}izes`;
  PROSE_FIXES[`${s}ised`] = `${s}ized`;
  PROSE_FIXES[`${s}ising`] = `${s}izing`;
  PROSE_FIXES[`${s}isation`] = `${s}ization`;
  PROSE_FIXES[`${s}isations`] = `${s}izations`;
}
const FIX_RES = Object.entries(PROSE_FIXES).map(
  ([wrong, right]) => [new RegExp(`(?<![A-Za-z0-9_])${wrong}(?![A-Za-z0-9_])`, 'gi'), right],
);
const DUP_RE = /(?<![A-Za-z0-9_])([A-Za-z]{2,})[ \t]+\1(?![A-Za-z0-9_])/gi;
const DUP_KEEP = new Set(['had', 'that']);
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]+`/g;
function matchCase(source, replacement) {
  if (source === source.toUpperCase() && /[A-Z]/.test(source)) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase() && source.slice(1) === source.slice(1).toLowerCase())
    return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}
/** Returns { text, fixes: ["initialised→initialized"] }. Idempotent. */
function fixProse(text) {
  const fixes = new Map();
  const record = (wrong, right) => {
    const key = `${wrong.toLowerCase()}→${right}`;
    fixes.set(key, (fixes.get(key) ?? 0) + 1);
  };
  const fixSegment = (prose) => {
    let out = prose.replace(DUP_RE, (match, word) => {
      if (DUP_KEEP.has(word.toLowerCase())) return match;
      record(`${word} ${word}`, word);
      return word;
    });
    for (const [re, right] of FIX_RES) {
      out = out.replace(re, (word) => {
        record(word, right);
        return matchCase(word, right);
      });
    }
    return out;
  };
  let out = '';
  let last = 0;
  for (const m of String(text ?? '').matchAll(CODE_SPAN)) {
    out += fixSegment(String(text).slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return { text: out + fixSegment(String(text ?? '').slice(last)), fixes: [...fixes] };
}

// Progress goes to stderr so stdout stays a single parseable JSON document:
// a publish that takes minutes must never look like a process that is stuck.
const progress = (msg) => process.stderr.write(`heimdall post: ${msg}\n`);

const GH_TIMEOUT_MS = Number(process.env.HEIMDALL_GH_TIMEOUT_MS ?? 120_000);
const GH_MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Spawns gh and always closes its stdin. Two hangs this prevents: `--input -`
 * never receiving its payload (promisify(execFile) silently DROPS the `input`
 * option — only exec/execSync support it), and gh opening an interactive prompt
 * (auth, keychain) against a stdin that is never EOF'd. The timeout is the last
 * resort so a stalled API call fails with a message instead of living forever.
 */
function run(cmd, args, { input, timeout = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`), { stderr }));
    }, timeout);
    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > GH_MAX_OUTPUT) {
        child.kill('SIGKILL');
        return finish(reject, Object.assign(new Error(`${cmd} output exceeded ${GH_MAX_OUTPUT} bytes`), { stderr }));
      }
      stdout += d;
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, Object.assign(e, { stderr })));
    child.on('close', (code) => (code === 0
      ? finish(resolve, stdout)
      : finish(reject, Object.assign(new Error(`${cmd} exited with code ${code}`), { stderr }))));
    child.stdin.end(input); // undefined => EOF immediately
  });
}

async function gh(args, { input, allowFail = false, onError } = {}) {
  try {
    return await run('gh', args, { input });
  } catch (e) {
    const msg = String(e.stderr || e.message).slice(0, 300);
    if (allowFail) { onError?.(msg); return ''; }
    throw new Error(`gh ${args.slice(0, 4).join(' ')} failed: ${msg}`);
  }
}

/**
 * Entry point. Failures print one line on stderr and exit 1: the caller is usually
 * an agent reading the tail of a run, and "gh api ... failed: <reason>" is the whole
 * story — a stack trace only buries it. Set HEIMDALL_DEBUG=1 for the stack.
 */
async function main() {
  const pr = JSON.parse(readFileSync(`${dir}/pr.json`, 'utf8'));
  const repo = process.env.HEIMDALL_REPO ?? (() => {
    const m = (pr.url || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
    if (!m) throw new Error('cannot derive repo from pr.json url; set HEIMDALL_REPO');
    return m[1];
  })();
  const consolidated = JSON.parse(readFileSync(`${dir}/consolidated.json`, 'utf8'));
  const summaryPath = `${dir}/summary.md`;
  if (!existsSync(summaryPath)) throw new Error('missing summary.md — build it before posting');
  let summaryBody = readFileSync(summaryPath, 'utf8');
  if (!summaryBody.includes(MARKER)) summaryBody = `${MARKER}\n${summaryBody}`;

  progress(`reading ${repo}#${pr.number} as current gh user…`);
  // Both listings are needed for dedupe (inline buckets + the summary comment this
  // script re-updates in place), neither depends on a post, so fetch them at once
  // — the paginated pulls-comments page is the slow one here.
  const [me, rcs, issueComments] = await Promise.all([
    gh(['api', 'user', '--jq', '.login']).then((out) => out.trim()),
    gh(['api', `repos/${repo}/pulls/${pr.number}/comments`, '--paginate']).then((out) => JSON.parse(out || '[]')),
    gh(['api', `repos/${repo}/issues/${pr.number}/comments`, '--paginate']).then((out) => JSON.parse(out || '[]')),
  ]);
  const myBuckets = new Set(
    rcs.filter((c) => c.user?.login === me && c.body?.includes('finding `') && c.line != null)
      .map((c) => `${c.path}:${Math.floor(c.line / 5)}`),
  );

  // Privacy guard: the numeric score map is private. Reject bodies that leaked it.
  const LEAK = /(impact|certainty|blastRadius|score)\s*[:=]\s*\d|→\s*\d{1,2}\s*\((blocker|major|minor|nit)\]/i;
  const violations = consolidated.filter((c) => LEAK.test(c.comment ?? ''));

  const inlineItems = [];
  const replies = [];
  const skipped = [];
  const proseFixes = [];
  let blockersPosted = 0;
  for (const c of consolidated) {
    if (violations.includes(c)) continue;
    const bucket = `${c.file}:${Math.floor(Number(c.line) / 5)}`;
    if (myBuckets.has(bucket)) { skipped.push(bucket); continue; }
    const t = TIERS[c.tier] ?? TIERS.nit;
    const tags = (c.mergedAgents ?? [c.agent]).length > 1 ? ` _[${(c.mergedAgents ?? []).join(' + ')}]_` : '';
    const cm = fixProse(tidyComment(c.comment));
    const ttl = fixProse(String(c.title ?? ''));
    for (const f of [...cm.fixes, ...ttl.fixes]) proseFixes.push(`${c.file}:${c.line} ${f}`);
    const comment = cm.text;
    const words = proseWords(comment);
    if (words > MAX_INLINE_WORDS) progress(`warning: comment for ${c.file}:${c.line} is ${words} prose words (cap ${MAX_INLINE_WORDS}) — voice rule violated, shortening it yourself is the fix`);
    const body = `**${t.icon} ${t.label} — ${capTitle(ttl.text)}**${tags}\n\n${comment}\n\n<sub>heimdall · finding \`${c.findingId}\` · advisory, human decides</sub>`;
    if (c.replyTo) replies.push({ commentId: c.replyTo, body });
    else inlineItems.push({ path: c.file, line: Number(c.line), side: 'RIGHT', body });
    if (c.tier === 'blocker') blockersPosted++;
  }

  // A surviving blocker posted THIS run is the condition that blocks the PR:
  // escalate the review event. Skipped duplicates already gate from an
  // earlier run. Never APPROVE under any counts.
  const requestChanges = blockersPosted > 0;
  const reviewEvent = requestChanges ? 'REQUEST_CHANGES' : 'COMMENT';

  // Prose gate on the summary too — its finding titles and gap-check notes
  // are LLM-written. Every fix declared on stderr and in the result JSON.
  const sm = fixProse(summaryBody);
  for (const f of sm.fixes) proseFixes.push(`summary ${f}`);
  summaryBody = sm.text;
  for (const f of proseFixes) progress(`prose gate: fixed ${f}`);

  const plan = { post: POST, repo, pr: pr.number, as: me, reviewEvent, inline: inlineItems.length, threadReplies: replies.length, skippedDuplicates: skipped, summaryBytes: summaryBody.length };
  if (violations.length) plan.rejectedLeakingPrivateScores = violations.map((v) => `${v.file}:${v.line}`);
  if (proseFixes.length) plan.proseFixes = proseFixes;
  if (!POST) {
    console.log(JSON.stringify({ ...plan, mode: 'plan-only (pass --post)' }, null, 2));
    process.exit(0);
  }
  if (violations.length) {
    console.error(`refusing to post ${violations.length} comment(s) containing private scores — strip numbers from consolidated.json`);
    process.exit(1);
  }

  let reviewPosted = false;
  let reviewError;
  if (inlineItems.length || requestChanges) {
    const n = `Heimdall left ${inlineItems.length} inline comment${inlineItems.length === 1 ? '' : 's'}`;
    const payload = JSON.stringify({
      commit_id: pr.headSha,
      event: reviewEvent,
      body: requestChanges
        ? `Heimdall requested changes — ${inlineItems.length ? `${n}; ` : 'blocking findings were raised; '}blockers must be resolved before merge. See the summary comment for the full picture.`
        : `${n}. See the summary comment for the full picture.`,
      comments: inlineItems,
    });
    progress(`posting review (${reviewEvent}) with ${inlineItems.length} inline comment(s)…`);
    const out = await gh(['api', '-X', 'POST', `repos/${repo}/pulls/${pr.number}/reviews`, '--input', '-'], {
      input: payload,
      allowFail: true,
      onError: (msg) => { reviewError = msg; },
    });
    reviewPosted = Boolean(out);
    if (!reviewPosted) progress(`review post FAILED: ${reviewError}`);
  }

  const replyUrls = [];
  const replyErrors = [];
  for (const [i, r] of replies.entries()) {
    progress(`reply ${i + 1}/${replies.length} in thread ${r.commentId}…`);
    const out = await gh(
      ['api', '-X', 'POST', `repos/${repo}/pulls/${pr.number}/comments/${r.commentId}/replies`, '--input', '-'],
      { input: JSON.stringify({ body: r.body }), allowFail: true, onError: (msg) => replyErrors.push(msg) },
    );
    try { replyUrls.push(JSON.parse(out).html_url); } catch { /* declared via count below */ }
  }

  // Chosen from the pre-post listing above: only this script writes the marker, so
  // nothing we just posted can be mistaken for an earlier summary.
  const existing = issueComments.filter((c) => (c.body ?? '').includes(MARKER)).pop();
  let summaryUrl;
  let updated = false;
  progress(`${existing ? 'updating' : 'posting'} summary comment (${summaryBody.length} bytes)…`);
  if (existing) {
    const out = await gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], {
      input: JSON.stringify({ body: summaryBody }),
    });
    summaryUrl = JSON.parse(out).html_url;
    updated = true;
  } else {
    const out = await gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr.number}/comments`, '--input', '-'], {
      input: JSON.stringify({ body: summaryBody }),
    });
    summaryUrl = JSON.parse(out).html_url;
  }

  console.log(JSON.stringify({
    ...plan,
    mode: 'posted',
    reviewPosted,
    ...(reviewError ? { reviewError } : {}),
    replyPosted: replyUrls.length,
    replyFailed: replies.length - replyUrls.length,
    ...(replyErrors.length ? { replyErrors } : {}),
    summaryUrl,
    summaryUpdated: updated,
  }, null, 2));
}

main().catch((e) => {
  console.error(`heimdall post failed: ${e instanceof Error ? e.message : String(e)}`);
  if (process.env.HEIMDALL_DEBUG && e instanceof Error) console.error(e.stack);
  process.exit(1);
});
