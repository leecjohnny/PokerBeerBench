import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  canonical,
  configSchema,
  creationSchema,
  resolveCreation,
  sha256,
  type CreationInput,
} from '../src/shared.js';
const fixtureUrl = new URL('../configs/benchmark.json', import.meta.url);
const biographies = Array.from({ length: 8 }, (_, index) => ({
  id: `player-${index + 1}`,
  publicBiography: `Public ${index + 1}`,
  privateBiography: `Private ${index + 1}`,
}));
const rawFixture = async (): Promise<unknown> => JSON.parse(await readFile(fixtureUrl, 'utf8'));
const input = (beerDemand: CreationInput['beerDemand']): CreationInput => ({
  players: structuredClone(biographies),
  beerDemand,
});

describe('simulation creation config', () => {
  it('resolves static demand across all four 50-week rotations', async () => {
    const config = resolveCreation(input({ mode: 'static', value: 7 }), await rawFixture(), 'sim');
    expect(config.beer.demand).toEqual(Array.from({ length: 4 }, () => Array(50).fill(7)));
    expect(config.beer.demandPack).toEqual({
      mode: 'static',
      id: sha256({ mode: 'static', demand: config.beer.demand }),
    });
  });
  it('resolves seeded demand deterministically without runtime randomness', async () => {
    const profile = await rawFixture();
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used');
    });
    const first = resolveCreation(input({ mode: 'random_seeded', seed: 'beer-1' }), profile, 'a');
    const again = resolveCreation(input({ mode: 'random_seeded', seed: 'beer-1' }), profile, 'b');
    const other = resolveCreation(input({ mode: 'random_seeded', seed: 'beer-2' }), profile, 'a');
    random.mockRestore();
    expect(first.beer.demand).toEqual(again.beer.demand);
    expect(first.beer.demand).not.toEqual(other.beer.demand);
    expect(first.beer.demand.flat()).toHaveLength(200);
    expect(
      first.beer.demand
        .flat()
        .every((value) => Number.isInteger(value) && value >= 0 && value <= 12),
    ).toBe(true);
    expect(first.beer.demandPack).toEqual({
      mode: 'random_seeded',
      seed: 'beer-1',
      id: sha256({ mode: 'random_seeded', demand: first.beer.demand }),
    });
  });
  it('accepts only an exact 4x50 provided demand matrix', async () => {
    const profile = await rawFixture();
    const values = Array.from({ length: 4 }, (_, rotation) =>
      Array.from({ length: 50 }, (_, week) => rotation * 50 + week),
    );
    expect(
      resolveCreation(input({ mode: 'provided', values }), profile, 'sim').beer.demand,
    ).toEqual(values);
    const invalid = [
      values.slice(0, 3),
      [...values, values[0]!],
      values.map((row) => row.slice(1)),
    ];
    for (const values of invalid)
      expect(creationSchema.safeParse(input({ mode: 'provided', values })).success).toBe(false);
  });
  it('requires exactly eight unique valid player descriptors', () => {
    const beerDemand = { mode: 'static' as const, value: 4 };
    expect(creationSchema.safeParse(input(beerDemand)).success).toBe(true);
    const duplicate = structuredClone(biographies);
    duplicate[7]!.id = duplicate[0]!.id;
    for (const players of [biographies.slice(0, 7), [...biographies, biographies[0]!], duplicate])
      expect(creationSchema.safeParse({ players, beerDemand }).success).toBe(false);
  });
  it('preserves prototype-like IDs and the existing 200-character limit', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'p'.repeat(200)]) {
      const creation = input({ mode: 'static', value: 4 });
      creation.players[0]!.id = id;
      expect(creationSchema.parse(creation).players[0]!.id).toBe(id);
    }
  });
});

describe('checked-in benchmark profile', () => {
  it('pins eight players and the complete audited tournament rules', async () => {
    const config = configSchema.parse(await rawFixture());
    expect(config).toMatchObject({
      version: 2,
      id: 'pokerbeer-full-benchmark-v1',
      messaging: { characterLimit: 1000 },
      poker: { startingStack: 60_000, finalWinnerStackMultiplier: 1.25 },
      beer: {
        holdingCost: 0.5,
        backlogCost: 1,
        orderDelayWeeks: 2,
        shippingDelayWeeks: 2,
        factoryRequestDelayWeeks: 1,
        factoryProductionDelayWeeks: 2,
        initialInventory: 12,
        initialPipelineQuantity: 4,
        warmupWeeks: 4,
      },
    });
    expect(config.players.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `player-${index + 1}`),
    );
    expect(config.poker.blindSchedule).toHaveLength(47);
    for (const [, big, bigAnte, hands] of config.poker.blindSchedule)
      expect([bigAnte, hands]).toEqual([big, 40]);
    expect(config.beer.demand).toHaveLength(4);
    expect(config.beer.demand.every((rotation) => rotation.length === 50)).toBe(true);
  });
  it('has a stable canonical profile hash independent of object key order', async () => {
    const raw = await rawFixture();
    const reversed = Object.fromEntries(Object.entries(raw as Record<string, unknown>).reverse());
    expect(canonical(reversed)).toBe(canonical(raw));
    expect(sha256(reversed)).toBe(sha256(raw));
    expect(sha256(raw)).toBe('75b49b1cbc90fa48c7234974c51ddd15ea8146b0a44ec05ff7859cbedc37fde4');
  });
});
