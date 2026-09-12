import { z } from 'zod';

export const roles = ['retailer', 'wholesaler', 'distributor', 'factory'] as const;
export type Role = (typeof roles)[number];
export type Stage = 'poker_a' | 'draft' | 'beer' | 'poker_b' | 'complete';
export type PlayerId = string;
export const maxPlayerIdLength = 200;
export const maxTurnIdLength = maxPlayerIdLength + 'beer:4:50:'.length;

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const playerId = z
  .string()
  .trim()
  .min(1)
  .max(maxPlayerIdLength)
  .refine((id) => id !== 'all');
const creationPlayerSchema = z.strictObject({
  id: playerId,
  publicBiography: z.string().trim().min(1).max(2_000),
  privateBiography: z.string().max(2_000).optional(),
});
const players = z
  .array(creationPlayerSchema)
  .length(8)
  .refine((items) => new Set(items.map(({ id }) => id)).size === 8, 'Player IDs must be unique.');
const demand = z.array(integer).length(50);
const beerDemandSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('static'), value: integer }),
  z.strictObject({ mode: z.literal('random_seeded'), seed: z.string().trim().min(1).max(200) }),
  z.strictObject({ mode: z.literal('provided'), values: z.array(demand).length(4) }),
]);
export const creationSchema = z.strictObject({ players, beerDemand: beerDemandSchema });
export type CreationInput = z.infer<typeof creationSchema>;

const blind = z
  .tuple([integer, integer.positive(), integer, integer.positive()])
  .refine(([small, big]) => small < big);
export const configSchema = z.object({
  version: z.literal(2),
  id: z.string().min(1),
  seed: z.string().min(1),
  players,
  messaging: z.object({ characterLimit: z.number().int().positive().max(10_000) }),
  poker: z
    .object({
      startingStack: z.number().int().positive(),
      finalWinnerStackMultiplier: z.number().positive(),
      blindSchedule: z.array(blind).min(1),
    })
    .refine((value) =>
      Number.isSafeInteger(value.startingStack * value.finalWinnerStackMultiplier),
    ),
  beer: z.object({
    demandPack: z.object({
      mode: z.enum(['static', 'random_seeded', 'provided']),
      id: z.string().regex(/^[0-9a-f]{64}$/),
      seed: z.string().min(1).max(200).optional(),
    }),
    holdingCost: z.number().nonnegative(),
    backlogCost: z.number().nonnegative(),
    orderDelayWeeks: z.number().int().positive(),
    shippingDelayWeeks: z.number().int().positive(),
    factoryRequestDelayWeeks: z.number().int().positive(),
    factoryProductionDelayWeeks: z.number().int().positive(),
    initialInventory: integer,
    initialPipelineQuantity: integer,
    warmupWeeks: z.literal(4),
    demand: z.array(demand).length(4),
  }),
});

export type BenchmarkConfig = z.infer<typeof configSchema>;
