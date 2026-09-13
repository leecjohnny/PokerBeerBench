import { loadConfig } from '../shared.js';
import { resolveOperatorUrl } from './config.js';
import { ArenaStore } from './db.js';
import { createArenaHttp } from './mcp.js';

export const operatorUrl = resolveOperatorUrl();
const profile = await loadConfig('configs/benchmark.json');
export const store = new ArenaStore(process.env.DATABASE_URL!, profile);
export const arena = createArenaHttp(store, operatorUrl);
