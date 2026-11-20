// mcp.ts — Anvil's Model Context Protocol endpoint (Streamable HTTP, JSON answers): modern
// server/discover plus the legacy initialize handshake, tools/list and tools/call over the same
// store the REST surface serves.

import { authOk, readBody, sendJson, type Ctx } from './http.ts';
import { OWNER_LOGIN } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import {
  branchTip,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  mergePull,
  type RepoRec,
  type Store,
} from './store.ts';

const SERVER_INFO = { name: 'anvil', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (store: Store, args: Record<string, unknown>) => Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function repoOrThrow(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  const found = getRepo(store, owner, repo);
  if (found === null) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: stringProp('The repository name.'),
      description: stringProp('A short description of the repository.'),
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (store, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === '') throw new Error('name is required');
      const repo = createRepo(store, OWNER_LOGIN, name, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (repo === null) throw new Error(`repository ${name} already exists`);
      return toolResult(repoJson(repo) as Record<string, unknown>);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: stringProp('The repository owner login.'),
      repo: stringProp('The repository name.'),
    },
    required: ['owner', 'repo'],
    run: (store, args) => toolResult(repoJson(repoOrThrow(store, args)) as Record<string, unknown>),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: stringProp('The repository owner login.'),
      repo: stringProp('The repository name.'),
      title: stringProp('The issue title.'),
      body: stringProp('The issue body.'),
    },
    required: ['owner', 'repo', 'title'],
    run: (store, args) => {
      const repo = repoOrThrow(store, args);
      const issue = createIssue(store, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(issueJson(repo, issue) as Record<string, unknown>);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: stringProp('The repository owner login.'),
      repo: stringProp('The repository name.'),
      state: stringProp('Filter by state: open, closed or all.'),
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const repo = repoOrThrow(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      const list = issues.map((issue) => issueJson(repo, issue));
      return {
        content: [{ type: 'text', text: JSON.stringify(list) }],
        structuredContent: list,
        isError: false,
      };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: stringProp('The repository owner login.'),
      repo: stringProp('The repository name.'),
      title: stringProp('The pull request title.'),
      body: stringProp('The pull request body.'),
      head: stringProp('The head branch name.'),
      base: stringProp('The base branch name.'),
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (store, args) => {
      const repo = repoOrThrow(store, args);
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) throw new Error('head or base branch not found');
      const pull = createPull(store, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return toolResult(pullJson(repo, pull) as Record<string, unknown>);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: stringProp('The repository owner login.'),
      repo: stringProp('The repository name.'),
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const repo = repoOrThrow(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new Error(`pull request ${String(args.pull_number)} not found`);
      const result = mergePull(repo, pull, 'squash');
      if (!result.ok) throw new Error(`pull request is not mergeable (${result.reason})`);
      return toolResult(pullJson(repo, pull) as Record<string, unknown>);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  })),
};

interface RpcOutcome {
  status: number;
  body: Record<string, unknown> | null;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function handleRpc(store: Store, message: Record<string, unknown>): RpcOutcome {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, TOOLS_LIST_RESULT) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return { status: 200, body: rpcError(id, -32602, `unknown tool: ${name}`) };
      }
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return { status: 200, body: rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`) };
      }
      try {
        return { status: 200, body: rpcResult(id, tool.run(store, args)) };
      } catch (error) {
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          }),
        };
      }
    }
    default:
      if (isNotification) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
  }
}

export async function handleMcp(ctx: Ctx): Promise<void> {
  if (ctx.method === 'DELETE') {
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  if (ctx.method === 'GET') {
    return sendJson(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'GET is not supported on this endpoint' } });
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 404, { message: 'Not Found' });
  if (!authOk(ctx.req)) {
    return sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  const text = (await readBody(ctx.req)).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(body)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of body) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = handleRpc(ctx.store, entry as Record<string, unknown>);
      if (outcome.body !== null) responses.push(outcome.body);
    }
    return sendJson(ctx, 200, responses);
  }
  if (typeof body !== 'object' || body === null) {
    return sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }
  const outcome = handleRpc(ctx.store, body as Record<string, unknown>);
  if (outcome.body === null) {
    ctx.res.writeHead(outcome.status, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  return sendJson(ctx, outcome.status, outcome.body);
}
