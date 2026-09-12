import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { creationFromConfig, creationSchema, loadConfig } from '../../src/shared.ts';
import { runTrial, TrialFailure, type TrialDependencies } from './run.ts';
import { errorDetails } from './atif.ts';
const DEFAULT_INSTRUCTION = 'Play your seat through the full PokerBeerBench tournament.';
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
export async function main(deps?: TrialDependencies): Promise<void> {
  const configIndex = process.argv.indexOf('--config');
  const configPath = configIndex < 0 ? 'configs/benchmark.json' : process.argv[configIndex + 1]!;
  required('OPENAI_API_KEY');
  const reasoning = z
    .enum(['low', 'medium', 'high', 'xhigh'])
    .parse(process.env.RESPONSES_REASONING_EFFORT ?? 'medium');
  const model = process.env.RESPONSES_MODEL ?? 'gpt-5.6-luna';
  const timeoutMs = Number(process.env.TRIAL_TIMEOUT_MS ?? 172_800_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('TRIAL_TIMEOUT_MS must be a positive integer.');
  const resultPath = process.env.HARBOR_RESULT_PATH ?? '/logs/artifacts/result.json';
  const trajectoryPath = process.env.HARBOR_TRAJECTORY_PATH ?? '/logs/agent/trajectory.json';
  if (!process.env.RESPONSES_EVENT_LOG_DIR)
    process.env.RESPONSES_EVENT_LOG_DIR = join(dirname(trajectoryPath), 'events');
  const arenaMcpUrl = required('ARENA_MCP_URL');
  if (new URL(arenaMcpUrl).protocol !== 'https:')
    throw new Error('Responses requires a public HTTPS ARENA_MCP_URL.');
  const profile = await loadConfig(configPath);
  const creation = process.env.TRIAL_CREATION_PATH
    ? creationSchema.parse(JSON.parse(await readFile(process.env.TRIAL_CREATION_PATH, 'utf8')))
    : creationFromConfig(profile);
  const resumeIds = process.env.RESPONSES_RESUME_IDS?.split(',');
  const abort = new AbortController();
  const interrupt = (signal: NodeJS.Signals) =>
    abort.abort(new Error(`Trial interrupted by ${signal}.`));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const save = async (output: Awaited<ReturnType<typeof runTrial>>) => {
    await Promise.all([
      atomicJson(trajectoryPath, output.trajectory),
      atomicJson(resultPath, output.result),
      atomicJson(join(dirname(resultPath), 'arena.json'), output.arena),
      atomicJson(join(dirname(resultPath), 'harness.json'), output.harness),
    ]);
  };
  try {
    const output = await runTrial(
      {
        creation,
        arenaMcpUrl,
        model,
        reasoning,
        instruction: process.env.HARBOR_INSTRUCTION ?? DEFAULT_INSTRUCTION,
        trialId: process.env.HARBOR_TRIAL_ID ?? crypto.randomUUID(),
        sessionName: process.env.HARBOR_SESSION_NAME ?? 'pokerbeer-bench',
        timeoutMs,
        abortSignal: abort.signal,
        ...(resumeIds ? { resumeIds } : {}),
      },
      deps,
    );
    await save(output);
  } catch (error) {
    if (!(error instanceof TrialFailure)) throw error;
    try {
      await save(error.output);
    } catch (writeError) {
      throw new AggregateError(
        [error.cause, writeError],
        'Trial failed and evidence export failed.',
        { cause: error.cause },
      );
    }
    throw error.cause;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify(errorDetails(error), null, 2));
    process.exitCode = 1;
  });
}
