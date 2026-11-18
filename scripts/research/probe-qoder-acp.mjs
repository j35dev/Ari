import { createRequire } from 'node:module'
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Explicit, opt-in investigation. Uses Ari's real ACP implementation; the one
// model prompt only operates on disposable files. No agent configuration changes.
const command = process.argv[2]
if (!command) throw new Error('Usage: node scripts/research/probe-qoder-acp.mjs <Qoder CLI binary>')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const req = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(req.resolve('electron-vite'))('esbuild')
const scratch = await mkdtemp(join(tmpdir(), 'ari-qoder-acp-'))
if (
  dirname(scratch) !== resolve(tmpdir()) ||
  !scratch.startsWith(join(tmpdir(), 'ari-qoder-acp-'))
) {
  throw new Error('Unexpected scratch directory')
}
const bundle = join(scratch, 'probe.cjs')
const output = resolve(root, 'docs/research/evidence/qoder-acp-feasibility/probe.json')

const source = `
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAcpAdapter } from './packages/providers/src/acp/acp-driver.ts';
import { AcpSessionPool } from './packages/providers/src/acp/session-pool.ts';

export async function probe(command, cwd) {
  const report = { testedAt: new Date().toISOString(), initialize: null, incomingClientMethods: [], turns: [], fileCopyVerified: false, spawnedProcesses: 0 };
  const pool = new AcpSessionPool();
  const children = [];
  let nativeId = null;
  const launch = { label: 'Qoder native ACP feasibility probe', command, args: ['--acp', '--strict-mcp-config'] };
  const spawnAgent = (launch, cwd) => {
    const child = spawn(launch.command, launch.args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push({ child, closed: new Promise(resolve => child.once('close', resolve)) });
    report.spawnedProcesses++;
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.result?.agentInfo) report.initialize = message.result;
          if (message.method && message.id != null && !report.incomingClientMethods.includes(message.method)) report.incomingClientMethods.push(message.method);
        } catch {}
      }
    });
    return {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid: child.pid,
      get killed() { return child.killed; },
      kill: signal => child.kill(signal),
      on: (event, listener) => child.on(event, listener),
      onExit: listener => child.on('close', listener),
    };
  };
  const turn = async (name, prompt, permissionMode, modelId = 'efficient', resumeOf = null) => {
    const row = { name, permissionMode, modelId, advertisedModels: [], advertisedEfforts: null, capabilities: null, eventCounts: {}, events: [], completed: false, approvalsAnswered: 0, durationMs: 0, resumedSameSession: null };
    report.turns.push(row);
    const startedAt = Date.now();
    let adapter;
    let timer;
    try {
      adapter = await createAcpAdapter(launch, {
        sessionId: 'qoder-feasibility-probe', workspacePath: cwd, prompt,
        modelId, permissionMode, resumeOf,
      }, spawnAgent, undefined, [], null, pool);
      row.advertisedModels = adapter.advertisedModels;
      row.advertisedEfforts = adapter.advertisedEfforts;
      row.capabilities = adapter.capabilities();
      timer = setTimeout(() => adapter.interrupt(), 90000);
      for await (const event of adapter.start()) {
        row.eventCounts[event.type] = (row.eventCounts[event.type] ?? 0) + 1;
        if (event.type === 'session-ref') { if (resumeOf) row.resumedSameSession = event.ref === resumeOf; nativeId = event.ref; continue; }
        if (event.type === 'approval-requested') {
          const allowed = event.options?.find(option => option.kind === 'allow_once');
          if (!allowed) throw new Error('No one-time allow option offered');
          adapter.respondApproval(event.approvalId, { optionId: allowed.optionId });
          row.approvalsAnswered++;
        }
        if (event.type === 'input-requested') adapter.respondInput(event.inputId, '');
        if (event.type !== 'thinking-delta') row.events.push(event);
        if (event.type === 'done') row.completed = true;
      }
    } catch (error) {
      row.error = { name: error.name, code: error.code ?? null, message: error.message };
    } finally {
      clearTimeout(timer);
      if (adapter) await adapter.dispose();
      row.durationMs = Date.now() - startedAt;
      console.log(JSON.stringify({ turn: name, completed: row.completed, events: row.events.map(event => event.type), error: row.error ?? null }));
    }
  };
  try {
    await writeFile(join(cwd, 'probe-input.txt'), 'ARI_QODER_PROBE_OK\\n');
    await turn('about-ask', '/about', 'ask');
    await turn('help-allow-edits', '/help', 'allow-edits');
    await turn('file-and-terminal-ask', 'This is a disposable compatibility probe. Use the file read tool to read probe-input.txt, use the file write tool to copy its exact contents to probe-output.txt, then use the terminal tool to run cmd /c type probe-output.txt. Work only on these two files in the current working directory. Do not use subagents, network, MCP, or other files. Reply only with the terminal output.', 'ask');
    try { report.fileCopyVerified = await readFile(join(cwd, 'probe-output.txt'), 'utf8') === 'ARI_QODER_PROBE_OK\\n'; } catch {}
    await turn('about-full-reasoning-model', '/about', 'full', 'qmodel_latest');
    await pool.shutdownAll();
    await Promise.all(children.map(entry => entry.closed));
    if (nativeId) await turn('load-after-process-restart', '/about', 'ask', 'efficient', nativeId);
  } finally {
    await pool.shutdownAll();
    await Promise.all(children.map(entry => entry.closed));
  }
  return report;
}
`

try {
  const built = await build({
    stdin: { contents: source, sourcefile: 'qoder-acp-probe.ts', resolveDir: root },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  await writeFile(bundle, built.outputFiles[0].contents)
  const { probe } = createRequire(bundle)(bundle)
  const report = await probe(command, scratch)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  if (
    !report.fileCopyVerified ||
    report.turns.some(
      (turn) =>
        turn.error || !turn.completed || turn.events.some((event) => event.type === 'error'),
    )
  ) {
    process.exitCode = 1
  }
  console.log(JSON.stringify({ evidence: output, fileCopyVerified: report.fileCopyVerified }))
} finally {
  // Remove only regular files this probe created. Leave unexpected directories
  // for inspection; never recursively delete files an agent may have added.
  for (const entry of await readdir(scratch, { withFileTypes: true })) {
    if (entry.isFile()) await unlink(join(scratch, entry.name))
  }
  await rmdir(scratch, { maxRetries: 5, retryDelay: 200 })
}
