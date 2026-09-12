import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  creationSchema,
  configSchema,
  type BenchmarkConfig,
  type CreationInput,
  type PlayerId,
} from './schema.ts';
export * from './schema.ts';
export const traceCapability = (id: string, key: string) =>
  createHmac('sha256', key).update(`atif:${id}`).digest('hex');

export const playerIds = (config: BenchmarkConfig): PlayerId[] =>
  config.players.map(({ id }) => id);

export const loadConfig = async (path: string): Promise<BenchmarkConfig> =>
  configSchema.parse(JSON.parse(await readFile(path, 'utf8')));

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');

export function seeded(seed: string): () => number {
  let state = 2_166_136_261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16_777_619);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function resolveCreation(
  raw: unknown,
  profileRaw: unknown,
  simulationSeed: string,
): BenchmarkConfig {
  const input = creationSchema.parse(raw);
  const profile = configSchema.parse(profileRaw);
  let demandValues: number[][];
  if (input.beerDemand.mode === 'static') {
    const value = input.beerDemand.value;
    demandValues = Array.from({ length: 4 }, () => Array(50).fill(value));
  } else if (input.beerDemand.mode === 'provided') {
    demandValues = input.beerDemand.values;
  } else {
    const seed = input.beerDemand.seed;
    demandValues = Array.from({ length: 4 }, (_, rotation) => {
      const random = seeded(`${seed}:rotation=${rotation + 1}`);
      return Array.from({ length: 50 }, () => Math.floor(random() * 13));
    });
  }
  const mode = input.beerDemand.mode;
  return configSchema.parse({
    ...profile,
    seed: simulationSeed,
    players: input.players,
    beer: {
      ...profile.beer,
      demandPack: {
        mode,
        id: sha256({ mode, demand: demandValues }),
        ...(mode === 'random_seeded' ? { seed: input.beerDemand.seed } : {}),
      },
      demand: demandValues,
    },
  });
}

export const creationFromConfig = (config: BenchmarkConfig): CreationInput => ({
  players: structuredClone(config.players),
  beerDemand: { mode: 'provided', values: structuredClone(config.beer.demand) },
});

export const biographyProjection = (config: BenchmarkConfig, ownId?: PlayerId | null) =>
  config.players.map(({ privateBiography, ...player }) => ({
    ...player,
    ...((ownId === null || player.id === ownId) && privateBiography !== undefined
      ? { privateBiography }
      : {}),
  }));

export const clone = <T>(value: T): T => structuredClone(value);
