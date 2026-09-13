import { z } from 'zod';

export const capabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{32,}$/);
export function resolveOperatorUrl(env = process.env) {
  const host =
    env.VERCEL_ENV === 'production'
      ? env.VERCEL_PROJECT_PRODUCTION_URL
      : env.VERCEL_ENV === 'preview' && env.VERCEL_URL;
  const origin = env.ARENA_ORIGIN || (host ? `https://${host}` : 'http://localhost:3100');
  const secret = capabilitySchema.parse(env.ARENA_MCP_SECRET);
  return new URL(`/mcp/${secret}`, new URL(origin).origin);
}
