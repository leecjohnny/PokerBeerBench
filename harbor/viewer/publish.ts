import { put } from '@vercel/blob';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { traceCapability } from '../../src/shared.ts';

const sensitive =
  /^(?:authorization|proxy-authorization|key|.*token|.*(?:api|private)[_-]?key|.*secret|viewer_key|.*capability|.*password|database_url)$/i;
export function redactTrace(key: string, value: unknown): unknown {
  if (
    /^(?:env|env_vars|environment_variables)$/i.test(key) &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
    return undefined;
  if (typeof value !== 'string') return value;
  if (sensitive.test(key)) return '[REDACTED]';
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, redactTrace);
  } catch {}
  return value
    .replace(/(\/mcp\/)[A-Za-z0-9_-]{32,}/gi, '$1[REDACTED]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9_.~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:https?|postgres(?:ql)?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&#](?:\w*key|\w*token|capability)=)[^\s&#"'<>\\]+/gi, '$1[REDACTED]');
}
export async function publishTraces(trialDir: string, simulationId: string, viewerKey: string) {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(viewerKey)) throw new Error('Invalid viewer key.');
  const capability = traceCapability(simulationId, viewerKey);
  const read = async (file: string) => JSON.parse(await readFile(join(trialDir, file), 'utf8'));
  const [root, result, jobConfig] = await Promise.all([
    read('agent/trajectory.json'),
    read('result.json'),
    read('../config.json'),
  ]);
  const children = root.subagent_trajectories ?? [];
  if (!/^[A-Za-z0-9_-]+$/.test(simulationId) || root.extra?.simulation_id !== simulationId)
    throw new Error('Simulation ID must match the source trajectory.');
  if (!result.finished_at || result.exception_info)
    throw new Error('Expected a completed Harbor trial.');
  const scratch = await mkdtemp(join(dirname(resolve(trialDir)), '.publish-'));
  const job = join(scratch, 'jobs', capability);
  const write = async (file: string, value: unknown) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, redactTrace).replaceAll(viewerKey, '[REDACTED]'));
  };
  try {
    await write(join(job, 'config.json'), { ...jobConfig, job_name: capability });
    for (const [index, trajectory] of [root, ...children].entries()) {
      const name = index ? `seat-${index}` : 'root';
      const config = {
        ...result.config,
        trial_name: name,
        task: index ? { name: trajectory.agent?.extra?.player_id ?? name } : result.config.task,
      };
      await write(join(job, name, 'config.json'), config);
      await write(join(job, name, 'result.json'), {
        ...result,
        trial_name: name,
        config,
        ...(index && { task_name: config.task.name, verifier_result: null, agent_result: null }),
      });
      await write(join(job, name, 'agent/trajectory.json'), trajectory);
    }
    const archive = join(scratch, 'harbor.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', dirname(job), capability], { stdio: 'inherit' });
    const uploaded = await put(`atif/${capability}/harbor.tar.gz`, createReadStream(archive), {
      access: 'private',
      multipart: true,
      allowOverwrite: true,
      contentType: 'application/gzip',
    });
    await put(
      `atif/${capability}/summary.json`,
      JSON.stringify({
        duration_seconds: (Date.parse(result.finished_at) - Date.parse(result.started_at)) / 1000,
        output_tokens: root.final_metrics.total_completion_tokens,
        trajectories: children.map((child: typeof root, index: number) => ({
          player_id: child.agent?.extra?.player_id,
          seat: String(index + 1),
        })),
      }),
      { access: 'private', allowOverwrite: true, contentType: 'application/json' },
    );
    return uploaded.url;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [trialDir, simulationId] = process.argv.slice(2);
  if (!trialDir || !simulationId)
    throw new Error('Usage: bun run harbor:publish TRIAL_DIR SIMULATION_ID');
  console.log(await publishTraces(trialDir, simulationId, process.env.VIEWER_KEY ?? ''));
}
