import { spawn } from 'node:child_process';

const GH_TIMEOUT_MS = Number(process.env.HEIMDALL_GH_TIMEOUT_MS ?? 120_000);
const GH_MAX_OUTPUT = 64 * 1024 * 1024;

export type GhRunner = (
  args: string[],
  opts?: { allowFail?: boolean; input?: string },
) => Promise<string>;

/**
 * Runs gh, capturing stdout, and ALWAYS closes stdin. Two hangs this prevents:
 * a `--input -` call that never receives its payload (promisify(execFile) silently
 * DROPS the `input` option — only exec/execSync support it), and gh opening an
 * interactive prompt (auth, keychain) against a stdin that is never EOF'd, which
 * blocks forever instead of failing. The timeout is the backstop: a stalled API
 * call rejects with a message instead of running indefinitely.
 */
function run(cmd: string, args: string[], { input, timeout = GH_TIMEOUT_MS }: { input?: string; timeout?: number } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let done = false;
    const finish = (fn: (v: never) => void, value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value as never);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`), { stderr }));
    }, timeout);
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > GH_MAX_OUTPUT) {
        child.kill('SIGKILL');
        finish(reject, Object.assign(new Error(`${cmd} output exceeded ${GH_MAX_OUTPUT} bytes`), { stderr }));
        return;
      }
      stdout += d;
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: Error) => finish(reject, Object.assign(err, { stderr })));
    child.on('close', (code) => (code === 0
      ? finish(resolve, stdout)
      : finish(reject, Object.assign(new Error(`${cmd} exited with code ${code}`), { stderr }))));
    child.stdin.end(input); // undefined => EOF immediately
  });
}

/**
 * Thin gh CLI wrapper. All GitHub I/O goes through the user's gh auth.
 * `command` exists so tests can drive the stdin plumbing without gh.
 */
export function createGh(command = 'gh'): GhRunner {
  return async (args, opts = {}) => {
    try {
      return await run(command, args, { input: opts.input });
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  };
}

export async function ghJson<T>(gh: GhRunner, args: string[]): Promise<T> {
  const out = await gh(args);
  return JSON.parse(out) as T;
}

/** Read a file at a ref via the contents API (raw media type). */
export async function ghReadFile(gh: GhRunner, repo: string, path: string, ref: string): Promise<string | null> {
  const out = await gh(
    ['api', `repos/${repo}/contents/${path}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw'],
    { allowFail: true },
  );
  return out || null;
}

export async function ghTree(gh: GhRunner, repo: string, ref: string): Promise<string[]> {
  const data = await ghJson<{ tree?: { path: string; type: string }[] }>(
    gh,
    ['api', `repos/${repo}/git/trees/${ref}`, '--jq', '.tree'],
  ).catch(() => ({ tree: [] }));
  return (data.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
}
