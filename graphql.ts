// graphql.ts — Anvil's GitHub GraphQL v4 subset: a small parser and executor covering the
// operations the suite sends (viewer, repository, node, __type introspection, issue/pull
// connections with cursor pagination, and the five mutations), with opaque global ids that
// round-trip through node(id:) and the mutation inputs.

import { authOk, readBody, sendJson, type Ctx } from './http.ts';
import { OWNER_ID, OWNER_LOGIN } from './http.ts';
import {
  addComment,
  branchTip,
  createIssue,
  createPull,
  diffCommits,
  findRepoById,
  getRepo,
  mergePull,
  nowIso,
  pullMergeable,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- global ids

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.split(':');
    if (split.length < 2) return null;
    return { kind: split[0]!, parts: split.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<[string, ValueNode]>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private next(): Token {
    const token = this.tokens[this.at]!;
    this.at += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expect('$');
            const varName = this.next().value;
            this.expect(':');
            this.parseType();
            if (this.atPunct('=')) {
              this.next();
              variableDefaults.set(varName, this.parseValue());
            }
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({
          operation: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('fragment definition missing "on"');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // directive name
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.next(); // argument name
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const nameToken = this.peek();
      if (nameToken.kind === 'name' && nameToken.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next().value;
      this.skipDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Array<[string, ValueNode]> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!this.atPunct('}')) {
        const fieldName = this.next().value;
        this.expect(':');
        fields.push([fieldName, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt', 'databaseId'],
  Organization: ['login', 'id', 'name', 'url', 'createdAt', 'updatedAt', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url', 'sshUrl', 'isFork', 'isArchived', 'stargazerCount', 'forkCount',
    'primaryLanguage', 'labels', 'collaborators', 'refs', 'object', 'assignableUsers', 'mentionableUsers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt',
    'labels', 'comments', 'repository', 'author', 'url', 'viewerCanUpdate', 'reactions', 'assignees',
    'participants', 'timelineItems', 'milestone', 'locked', 'activeLockReason',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'author', 'url',
    'additions', 'deletions', 'changedFiles', 'commits', 'headRef', 'baseRef', 'mergedBy',
    'mergeCommit', 'labels', 'comments', 'reviews', 'repository', 'isDraft', 'viewerCanUpdate',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Ref: ['name', 'prefix', 'target', 'repository'],
  Commit: ['oid', 'message', 'authoredDate', 'author', 'tree', 'parents'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount', 'codeCount', 'repositoryCount', 'userCount', 'wikiCount'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  LockReason: ['OFF_TOPIC', 'TOO_HEATED', 'RESOLVED', 'SPAM'],
};

function typeObject(name: string): Record<string, unknown> | null {
  if (ENUM_TYPES[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: ENUM_TYPES[name]!.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false })),
      possibleTypes: null,
      inputFields: null,
      ofType: null,
    };
  }
  if (TYPE_FIELDS[name] !== undefined || name === 'Node') {
    const fields = TYPE_FIELDS[name] ?? ['id'];
    return {
      __typename: '__Type',
      name,
      kind: name === 'Node' ? 'INTERFACE' : 'OBJECT',
      description: null,
      fields: fields.map((field) => ({ __typename: '__Field', name: field, description: null, args: [], isDeprecated: false })),
      enumValues: null,
      possibleTypes: null,
      inputFields: null,
      ofType: null,
    };
  }
  return null;
}

// ---------------------------------------------------------------- object factories

interface ExecCtx {
  store: Store;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> & { __typename: string };

function userObject(): GqlValue {
  return {
    __typename: 'User',
    id: gid('User', OWNER_ID),
    databaseId: OWNER_ID,
    login: OWNER_LOGIN,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
    avatarUrl: '',
    url: `https://github.com/${OWNER_LOGIN}`,
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
  };
}

function repoObject(repo: RepoRec): GqlValue {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    owner: userObject(),
    createdAt: repo.createdAt,
    updatedAt: repo.createdAt,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    sshUrl: `git@github.com:${repo.owner}/${repo.name}.git`,
    isFork: false,
    isArchived: false,
    stargazerCount: 0,
    forkCount: 0,
    primaryLanguage: null,
  };
}

function issueObject(repo: RepoRec, issue: IssueRec): GqlValue {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: gid('Issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    author: userObject(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    viewerCanUpdate: true,
    locked: false,
    activeLockReason: null,
    milestone: null,
  };
}

function pullObject(repo: RepoRec, pull: PullRec): GqlValue {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: gid('PullRequest', repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    author: userObject(),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    isDraft: false,
    viewerCanUpdate: true,
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`anvil-cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^anvil-cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function connection(typeName: string, all: GqlValue[], args: Record<string, unknown>): GqlValue {
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : all.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = indexFromCursor(args.after);
    if (index >= 0) start = index + 1;
  }
  const nodes = all.slice(start, start + first);
  const lastIndex = start + nodes.length - 1;
  return {
    __typename: typeName,
    nodes,
    edges: nodes.map((node, i) => ({ __typename: `${typeName.replace(/Connection$/, '')}Edge`, node, cursor: cursorFor(start + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + nodes.length < all.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorFor(start) : null,
      endCursor: nodes.length > 0 ? cursorFor(lastIndex) : null,
    },
    totalCount: all.length,
  };
}

// ---------------------------------------------------------------- resolvers

type Resolver = (parent: GqlValue | null, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function repoFromId(ctx: ExecCtx, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return findRepoById(ctx.store, Number(decoded.parts[0]));
}

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(),
    repository: (_parent, args, ctx) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = getRepo(ctx.store, args.owner, args.name);
      return repo === null ? null : repoObject(repo);
    },
    node: (_parent, args, ctx) => {
      if (typeof args.id !== 'string') return null;
      const decoded = decodeGid(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
        return repo === null ? null : repoObject(repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo !== null && repo !== undefined && issue !== undefined ? issueObject(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        return repo !== null && repo !== undefined && pull !== undefined ? pullObject(repo, pull) : null;
      }
      if (decoded.kind === 'User') return userObject();
      return null;
    },
    __type: (_parent, args) => (typeof args.name === 'string' ? typeObject(args.name) : null),
    __schema: () => ({
      __typename: '__Schema',
      description: null,
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      subscriptionType: null,
      types: [],
      directives: [],
    }),
  },
  Repository: {
    defaultBranchRef: (parent) => {
      const repo = parent!._repo as RepoRec;
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return {
        __typename: 'Ref',
        name: repo.defaultBranch,
        prefix: 'refs/heads/',
        target: { __typename: 'Commit', oid: tip },
      };
    },
    issue: (parent, args) => {
      const repo = parent!._repo as RepoRec;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent!._repo as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state).toUpperCase()) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Record<string, unknown>) : null;
      const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction.toUpperCase() : 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return connection('IssueConnection', issues.map((issue) => issueObject(repo, issue)), args);
    },
    pullRequest: (parent, args) => {
      const repo = parent!._repo as RepoRec;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullObject(repo, pull);
    },
    pullRequests: (parent, args) => {
      const repo = parent!._repo as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state).toUpperCase()) : null;
      if (states !== null) {
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return states.includes(state);
        });
      }
      pulls.sort((a, b) => b.number - a.number);
      return connection('PullRequestConnection', pulls.map((pull) => pullObject(repo, pull)), args);
    },
  },
  Issue: {
    repository: (parent) => repoObject(parent!._repo as RepoRec),
    labels: (parent) => {
      const repo = parent!._repo as RepoRec;
      const issue = parent!._issue as IssueRec;
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((name) => ({
          __typename: 'Label',
          id: gid('Label', name),
          name,
          color: repo.labels.get(name.toLowerCase())?.color ?? 'ededed',
          description: null,
        })),
      };
    },
    comments: (parent, args) => {
      const repo = parent!._repo as RepoRec;
      const issue = parent!._issue as IssueRec;
      const all = issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: gid('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
        author: userObject(),
        url: '',
      })) as GqlValue[];
      return connection('IssueCommentConnection', all, args);
    },
  },
  PullRequest: {
    repository: (parent) => repoObject(parent!._repo as RepoRec),
    mergeable: (parent) => pullMergeable(parent!._repo as RepoRec, parent!._pull as PullRec),
    files: (parent, args) => {
      const repo = parent!._repo as RepoRec;
      const pull = parent!._pull as PullRec;
      const baseSha = pull.merged ? pull.baseSha : branchTip(repo, pull.baseRef) ?? pull.baseSha;
      const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
      const all = diffCommits(repo, baseSha, headSha).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      })) as GqlValue[];
      return connection('PullRequestChangedFileConnection', all, args);
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const issue = createIssue(ctx.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('issue not found');
      const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === null || repo === undefined || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      repo.issueJsonCache.delete(issue.number);
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new Error('head or base branch not found');
      const pull = createPull(ctx.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('pull request not found');
      const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      if (repo === null || repo === undefined || pull === undefined) throw new Error('pull request not found');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toUpperCase() : 'MERGE';
      const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
      const result = mergePull(repo, pull, method);
      if (!result.ok) throw new Error(`pull request is not mergeable (${result.reason})`);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('subject not found');
      const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === null || repo === undefined || issue === undefined) throw new Error('subject not found');
      const comment = addComment(repo, issue, ctx.store.nextCommentId(), typeof input.body === 'string' ? input.body : '');
      repo.issueJsonCache.delete(issue.number);
      const node = {
        __typename: 'IssueComment',
        id: gid('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
        author: userObject(),
        url: '',
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(issue.comments.length - 1) },
        subject: issueObject(repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
};

// ---------------------------------------------------------------- executor

function resolveValue(node: ValueNode, variables: Record<string, unknown>, defaults: Map<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (Object.prototype.hasOwnProperty.call(variables, node.name)) return variables[node.name];
      const fallback = defaults.get(node.name);
      return fallback === undefined ? undefined : resolveValue(fallback, variables, defaults);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables, defaults);
      return out;
    }
  }
}

function typeMatches(valueType: string, condition: string | null): boolean {
  if (condition === null) return true;
  if (valueType === condition) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'Organization', 'IssueComment'].includes(valueType);
  return false;
}

function executeSelectionSet(
  ctx: ExecCtx,
  typeName: string,
  value: GqlValue | null,
  selections: readonly SelectionNode[],
  variables: Record<string, unknown>,
  defaults: Map<string, ValueNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (value !== null && typeMatches(value.__typename, selection.typeCondition)) {
        Object.assign(out, executeSelectionSet(ctx, value.__typename, value, selection.selectionSet, variables, defaults));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && value !== null && typeMatches(value.__typename, fragment.typeCondition)) {
        Object.assign(out, executeSelectionSet(ctx, value.__typename, value, fragment.selectionSet, variables, defaults));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const resolver = resolvers[typeName]?.[selection.name];
    let resolved: unknown;
    if (resolver !== undefined) {
      const args: Record<string, unknown> = {};
      for (const [argName, argValue] of selection.args) args[argName] = resolveValue(argValue, variables, defaults);
      try {
        resolved = resolver(value, args, ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        out[responseKey] = null;
        continue;
      }
    } else if (value !== null && selection.name in value) {
      resolved = value[selection.name];
    } else {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, resolved, selection, variables, defaults);
  }
  return out;
}

function completeValue(
  ctx: ExecCtx,
  resolved: unknown,
  field: FieldNode,
  variables: Record<string, unknown>,
  defaults: Map<string, ValueNode>,
): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => completeValue(ctx, item, field, variables, defaults));
  }
  if (typeof resolved === 'object') {
    const object = resolved as GqlValue;
    if (field.selectionSet !== null && typeof object.__typename === 'string') {
      return executeSelectionSet(ctx, object.__typename, object, field.selectionSet, variables, defaults);
    }
    return object;
  }
  return resolved;
}

export function executeGraphql(store: Store, operation: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  if (typeof operation.query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(operation.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const variables = typeof operation.variables === 'object' && operation.variables !== null ? (operation.variables as Record<string, unknown>) : {};
  let op: OperationNode | undefined;
  if (typeof operation.operationName === 'string' && operation.operationName !== '') {
    op = document.operations.find((candidate) => candidate.name === operation.operationName) ?? document.operations[0];
  } else {
    op = document.operations[0];
  }
  if (op === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { store, fragments: document.fragments, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootValue: GqlValue = { __typename: rootType };
  const data = executeSelectionSet(ctx, rootType, rootValue, op.selectionSet, variables, op.variableDefaults);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------- HTTP

export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (!authOk(ctx.req)) {
    return sendJson(ctx, 401, { message: 'Bad credentials', errors: [{ message: 'Bad credentials' }] });
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 404, { message: 'Not Found' });
  const text = (await readBody(ctx.req)).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeGraphql(ctx.store, (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown }));
    return sendJson(ctx, 200, results);
  }
  const result = executeGraphql(ctx.store, (body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown });
  return sendJson(ctx, 200, result);
}
