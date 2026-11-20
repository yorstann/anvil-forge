// http.ts — request plumbing shared by every surface: JSON answers with a request id, body
// reading, bearer auth, and pagination.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** The one user this forge serves: the trial token's owner (the scenario's viewer). */
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'ada iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The decoded URL pathname. */
  path: string;
  query: URLSearchParams;
  /** The request's own origin (http://host) for absolute Link URLs. */
  origin: string;
  requestId: string;
}

export function makeCtx(store: Store, req: IncomingMessage, res: ServerResponse): Ctx {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // keep the raw path
  }
  requestSeq += 1;
  const host = req.headers.host ?? '127.0.0.1';
  return {
    store,
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase(),
    path,
    query: url.searchParams,
    origin: `http://${host}`,
    requestId: `anvil-${requestSeq}`,
  };
}

/** The token the trial expects, or '' when the process runs standalone (any token accepted). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Whether the request carries the suite's bearer token. With no expected token configured
 * (standalone runs), any presented token is accepted — the suite always configures one.
 */
export function authOk(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const header = req.headers.authorization;
  if (header === undefined || header === '') return false;
  let presented: string | null = null;
  if (header.startsWith('Bearer ')) presented = header.slice('Bearer '.length).trim();
  else if (header.startsWith('token ')) presented = header.slice('token '.length).trim();
  else if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const user = separator < 0 ? decoded : decoded.slice(0, separator);
      const pass = separator < 0 ? '' : decoded.slice(separator + 1);
      presented = pass !== '' ? pass : user;
    } catch {
      presented = null;
    }
  }
  if (presented === null || presented === '') return false;
  return expected === '' || presented === expected;
}

export function sendJson(ctx: Ctx, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    'x-github-media-type': 'github.v3',
    ...extraHeaders,
  });
  ctx.res.end(text);
}

export function sendRaw(ctx: Ctx, status: number, body: Buffer, contentType: string, extraHeaders: Readonly<Record<string, string>> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; `{}` for an empty body, null for malformed JSON. */
export function parseJsonBody(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface Page<T> {
  items: T[];
  linkHeader: string | null;
}

/** Slice a list by ?page / ?per_page and build the Link header (absolute, same-origin URLs). */
export function paginate<T>(ctx: Ctx, all: readonly T[], pathWithQuery: string): Page<T> {
  const perPageRaw = Number(ctx.query.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const base = pathWithQuery.split('?')[0]!;
  const buildUrl = (targetPage: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `${ctx.origin}${base}?${params.toString()}`;
  };
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  if (page < lastPage) {
    links.push(`<${buildUrl(page + 1)}>; rel="next"`);
    links.push(`<${buildUrl(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${buildUrl(1)}>; rel="first"`);
    links.push(`<${buildUrl(page - 1)}>; rel="prev"`);
  }
  return { items, linkHeader: links.length > 0 ? links.join(', ') : null };
}
