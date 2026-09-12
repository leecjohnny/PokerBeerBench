import { loadConfig } from '../shared.js';
import { ArenaStore } from './db.js';
import { createArenaHttp } from './mcp.js';

const { DATABASE_URL: databaseUrl, ARENA_MCP_URL: arenaUrl } = process.env;
if (!databaseUrl || !arenaUrl) throw new Error('DATABASE_URL and ARENA_MCP_URL are required.');
export const operatorUrl = new URL(arenaUrl);
export const store = new ArenaStore(databaseUrl, await loadConfig('configs/benchmark.json'));
export const arena = createArenaHttp(store, operatorUrl.href);
