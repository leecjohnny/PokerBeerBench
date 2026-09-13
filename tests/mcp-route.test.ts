import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { ArenaStore } from '../src/arena/db.ts';
import { sha256 } from '../src/shared.ts';

const fixture = vi.hoisted(() => ({
  operatorUrl: 'https://arena.test/mcp/operator-capability-0000000000000000',
  playerCapability: 'player-capability-0000000000000000',
  store: {
    getSimulation: vi.fn(),
    resolveCapability: vi.fn(),
    playerRules: vi.fn(),
  },
}));
vi.mock('../src/arena/vercel.js', async () => {
  const { createArenaHttp } = await import('../src/arena/mcp.ts');
  return {
    operatorUrl: new URL(fixture.operatorUrl),
    arena: createArenaHttp(fixture.store as unknown as ArenaStore, new URL(fixture.operatorUrl)),
  };
});
const { default: route } = await import('../api/mcp/[capability].ts');
const { arena } = await import('../src/arena/vercel.js');

beforeEach(() => {
  vi.clearAllMocks();
  fixture.store.getSimulation.mockResolvedValue({ simulation_id: 'simulation-1' });
  fixture.store.playerRules.mockResolvedValue({ rules: 'player rules' });
  fixture.store.resolveCapability.mockImplementation(async (hash: string) =>
    hash === sha256(fixture.playerCapability)
      ? { simulationId: 'simulation-1', playerId: 'player-1', seat: 0 }
      : null,
  );
});
afterAll(() => arena.close());

function call(capability: string, operator = false) {
  return route.fetch(
    new Request(
      `https://arena.test/api/mcp?capability=${encodeURIComponent(capability)}${operator ? '&create' : ''}`,
      {
        method: 'POST',
        headers: {
          host: 'arena.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: operator ? 'get_simulation' : 'get_rules',
            arguments: operator ? { simulation_id: 'simulation-1' } : {},
          },
        }),
      },
    ),
  );
}

it.each(['not-a-capability', '$&', '$`', "$'", '$$'])(
  'rejects the literal invalid capability %s without reaching operator tools',
  async (capability) => {
    expect((await call(capability, true)).status).toBe(404);
    expect(fixture.store.getSimulation).not.toHaveBeenCalled();
  },
);
it('preserves legitimate operator and player authorization through the route', async () => {
  const operator = await call(new URL(fixture.operatorUrl).pathname.split('/').at(-1)!, true);
  expect(operator.status).toBe(200);
  expect(await operator.text()).toContain('simulation-1');
  expect(fixture.store.getSimulation).toHaveBeenCalledWith('simulation-1');

  const player = await call(fixture.playerCapability);
  expect(player.status).toBe(200);
  expect(await player.text()).toContain('player rules');
  expect(fixture.store.playerRules).toHaveBeenCalledWith({
    simulationId: 'simulation-1',
    playerId: 'player-1',
    seat: 0,
  });
  expect((await call(fixture.playerCapability, true)).status).toBe(404);
});
