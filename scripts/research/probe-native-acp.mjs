import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Metadata-only probe: no prompts, model inference, or changes to user settings.
const [kind, binary] = process.argv.slice(2)
if (!['qoder', 'muse', 'deepseek'].includes(kind) || !binary) {
  throw new Error(
    'Usage: node scripts/research/probe-native-acp.mjs <qoder|muse|deepseek> <CLI path>',
  )
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cache = join(root, 'node_modules', '.cache', 'ari-native-acp-probes')
await mkdir(cache, { recursive: true })
const scratch = await mkdtemp(join(cache, `${kind}-`))
if (dirname(scratch) !== cache) throw new Error('Unexpected probe directory')
const bundle = join(scratch, 'probe.cjs')
const req = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(req.resolve('electron-vite'))('esbuild')
const source = `
import { AcpConnection } from './packages/providers/src/acp/connection.ts';
import { resolveAcpLaunch } from './packages/providers/src/acp/launches.ts';
import { modelsFromConfigOptions, sessionResumeSupported } from './packages/providers/src/acp/acp-driver.ts';
import { thoughtEffortsFromSession } from './packages/providers/src/acp/thought.ts';
import { spawnCli } from './packages/providers/src/spawn-cli.ts';
import { join } from 'node:path';

export async function probe(kind, binary, cwd) {
  const report = { kind, testedAt: new Date().toISOString(), inferenceCalls: 0, protocol: null, agentInfo: null, models: [], efforts: null, configOptions: [], resumedSameSession: false };
  const base = resolveAcpLaunch(kind, { cliBinaryPath: binary });
  if (!base) throw new Error('ACP launch unavailable');
  const launch = { ...base, env: { ...base.env, ...(kind === 'deepseek' ? { DSH_HOME: join(cwd, 'dsh-home') } : {}) } };
  const children = [];
  const spawn = (launch, cwd) => {
    const child = spawnCli(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(new Promise(resolve => child.once('close', resolve)));
    child.onExit = listener => child.on('close', listener);
    return child;
  };
  let connection;
  try {
    connection = await AcpConnection.connect({ launch, cwd, spawn });
    report.protocol = connection.initialize.protocolVersion;
    report.agentInfo = connection.initialize.agentInfo;
    report.resumeAdvertised = sessionResumeSupported(connection.initialize);
    const created = await connection.newSession(cwd);
    report.models = modelsFromConfigOptions(created.configOptions ?? []);
    report.efforts = thoughtEffortsFromSession(created);
    report.configOptions = created.configOptions ?? [];
    console.log(JSON.stringify({ phase: 'opened', kind, models: report.models.length, resumeAdvertised: report.resumeAdvertised }));
    await connection.shutdown();
    await Promise.all(children);
    connection = await AcpConnection.connect({ launch, cwd, spawn });
    const resumed = report.resumeAdvertised
      ? await connection.resumeSession(created.sessionId, cwd)
      : await connection.loadSession(created.sessionId, cwd);
    report.resumedSameSession = resumed.sessionId === created.sessionId;
  } catch (error) {
    report.error = { name: error.name, code: error.code ?? null, message: error.message };
  } finally {
    if (connection) await connection.shutdown();
    await Promise.all(children);
  }
  return report;
}
`
try {
  const built = await build({
    stdin: { contents: source, resolveDir: root, sourcefile: 'native-acp-probe.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  await writeFile(bundle, built.outputFiles[0].contents)
  const { probe } = createRequire(bundle)(bundle)
  const report = await probe(kind, resolve(binary), scratch)
  const outputDir = join(root, 'docs', 'research', 'evidence', 'native-provider-metadata')
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, `${kind}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (report.error || !report.resumedSameSession) process.exitCode = 1
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
