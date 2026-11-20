// app.ts — Anvil, a GitHub-compatible git forge in one Node process: git smart HTTP, the
// REST v3 subset, GraphQL v4 and an MCP endpoint over one in-memory store. Standard library
// only; main.ts owns the entry <-> env lifecycle, this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { makeCtx, sendJson, type Ctx } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

async function dispatch(ctx: Ctx): Promise<void> {
  const { path, method } = ctx;

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  if (path === '/mcp') {
    await handleMcp(ctx);
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphql(ctx);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(ctx);
    return;
  }

  // Git smart HTTP lives at /{owner}/{repo}.git/...
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    await handleGit(ctx);
    return;
  }

  sendJson(ctx, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const ctx = makeCtx(store, req, res);
    dispatch(ctx).catch(() => {
      // A request must never take the process down: answer 500 and keep serving.
      try {
        if (!res.headersSent) sendJson(ctx, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // the socket is already gone
      }
    });
  });
}
