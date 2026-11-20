// rest.ts — Anvil's GitHub REST v3 subset: users, repositories, branches, commits, contents,
// git refs, labels, issues, comments and pull requests.

import { lookupPath, parseCommit, parseIdent, parseTree } from './git.ts';
import {
  OWNER_ID,
  OWNER_LOGIN,
  authOk,
  paginate,
  parseJsonBody,
  readBody,
  sendError,
  sendJson,
  type Ctx,
} from './http.ts';
import {
  addComment,
  branchNames,
  branchTip,
  commitFileChange,
  commitTree,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  diffCommits,
  getRepo,
  listRepos,
  mergePull,
  nowIso,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

const JSON_HEADERS = { 'x-oauth-scopes': 'repo, read:org' };

export function userJson(): Record<string, unknown> {
  return {
    login: OWNER_LOGIN,
    id: OWNER_ID,
    type: 'User',
    site_admin: false,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
    avatar_url: '',
    html_url: `https://github.com/${OWNER_LOGIN}`,
    url: `/api/v3/user`,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const openCount = [...repo.issues.values()].filter((issue) => issue.state === 'open').length +
    [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: OWNER_ID, type: 'User' },
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openCount,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name.toLowerCase());
  const canonical = label?.name ?? name;
  let hash = 0;
  for (const ch of canonical) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return {
    id: Math.abs(hash) % 100000000,
    node_id: Buffer.from(`Label:${canonical}`).toString('base64'),
    name: canonical,
    color: label?.color ?? 'ededed',
    description: null,
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(canonical)}`,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** The serialized issue (the read workload's hot path caches this string per issue). */
export function issueJsonText(repo: RepoRec, issue: IssueRec): string {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached !== undefined) return cached;
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  repo.issueJsonCache.set(issue.number, text);
  return text;
}

export function commentJson(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`).toString('base64'),
    body: comment.body,
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    draft: false,
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function refJson(repo: RepoRec, ref: string): Record<string, unknown> {
  return {
    ref,
    node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
    object: { type: 'commit', sha: repo.refs.get(ref) ?? '', url: '' },
  };
}

function commitListItem(repo: RepoRec, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  const iso = (ts: number): string => new Date(ts * 1000).toISOString();
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: '' },
      author: { name: author.name, email: author.email, date: iso(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: iso(committer.timestamp) },
      comment_count: 0,
    },
    author: author.email === 'adaiversen@example.invalid' ? { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' } : null,
    committer: committer.email === 'adaiversen@example.invalid' ? { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' } : null,
    parents: info.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** Validate a create-issue/pull label list against the repo's labels; canonical names or null. */
function canonicalLabels(repo: RepoRec, raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : null;
    if (name === null) return null;
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return null;
    names.push(label.name);
  }
  return names;
}

export async function handleRest(ctx: Ctx): Promise<void> {
  const segments = ctx.path.split('/').filter((segment) => segment !== '');
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (ctx.method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, {
      current_user_url: `${ctx.origin}/api/v3/user`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues?q={query}`,
      rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
    }, JSON_HEADERS);
  }

  if (!authOk(ctx.req)) return sendError(ctx, 401, 'Requires authentication');

  if (rest[0] === 'meta' && rest.length === 1 && ctx.method === 'GET') {
    return sendJson(ctx, 200, {
      verifiable_password_authentication: false,
      github_services_sha: 'anvil',
      installed_version: 'anvil-1.0.0',
    });
  }

  if (rest[0] === 'user' && rest.length === 1 && ctx.method === 'GET') {
    return sendJson(ctx, 200, userJson());
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (ctx.method === 'GET') {
      const page = paginate(ctx, listRepos(ctx.store, OWNER_LOGIN).map((repo) => repoJson(repo)), ctx.path);
      return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
      const repo = createRepo(ctx.store, OWNER_LOGIN, name, {
        description: typeof body.description === 'string' ? body.description : '',
        isPrivate: body.private === true,
      });
      if (repo === null) return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
      return sendJson(ctx, 201, repoJson(repo));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) return sendError(ctx, 404, 'Not Found');
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = getRepo(ctx.store, owner, repoName);
  if (repo === null) return sendError(ctx, 404, 'Not Found');
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (ctx.method === 'GET') return sendJson(ctx, 200, repoJson(repo));
    if (ctx.method === 'PATCH') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      return sendJson(ctx, 200, repoJson(repo));
    }
    if (ctx.method === 'DELETE') {
      deleteRepo(ctx.store, owner, repoName);
      return sendNoContent(ctx);
    }
    return sendError(ctx, 404, 'Not Found');
  }

  return handleRepoTail(ctx, repo, tail);
}

async function handleRepoTail(ctx: Ctx, repo: RepoRec, tail: string[]): Promise<void> {
  const [head, ...rest] = tail as [string, ...string[]];

  // ---- branches
  if (head === 'branches') {
    if (rest.length === 0 && ctx.method === 'GET') {
      const branches = branchNames(repo).map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: '' },
        protected: false,
      }));
      const page = paginate(ctx, branches, ctx.path);
      return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
    }
    if (rest.length > 0 && ctx.method === 'GET') {
      const branch = rest.join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return sendError(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
    }
    return sendError(ctx, 404, 'Not Found');
  }

  // ---- commits list
  if (head === 'commits' && rest.length === 0 && ctx.method === 'GET') {
    const shaParam = ctx.query.get('sha');
    let start: string | null = null;
    if (shaParam !== null && shaParam !== '') {
      start = branchTip(repo, shaParam) ?? (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : null);
      if (start === null) return sendError(ctx, 404, 'Not Found');
    } else {
      start = branchTip(repo, repo.defaultBranch);
      if (start === null) return sendJson(ctx, 409, { message: 'Git Repository is empty.' });
    }
    const items: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let current: string | null = start;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const item = commitListItem(repo, current);
      if (item === null) break;
      items.push(item);
      const parents = (item.parents as Array<{ sha: string }>);
      current = parents.length > 0 ? parents[0]!.sha : null;
    }
    const page = paginate(ctx, items, ctx.path);
    return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
  }

  // ---- contents
  if (head === 'contents') {
    return handleContents(ctx, repo, rest);
  }

  // ---- git refs
  if (head === 'git' && rest[0] === 'refs') {
    if (rest.length === 1) {
      if (ctx.method === 'GET') {
        const refs = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
        return sendJson(ctx, 200, refs);
      }
      if (ctx.method === 'POST') {
        const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
        if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || repo.objects.get(sha)?.type !== 'commit') {
          return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'invalid' }] });
        }
        if (repo.refs.has(ref)) return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'custom', message: 'Reference already exists' }] });
        repo.refs.set(ref, sha);
        return sendJson(ctx, 201, refJson(repo, ref));
      }
      return sendError(ctx, 404, 'Not Found');
    }
    if (ctx.method === 'GET') {
      const joined = rest.slice(1).join('/');
      const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      if (!repo.refs.has(ref)) return sendError(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, refJson(repo, ref));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  // ---- labels
  if (head === 'labels' && rest.length === 0) {
    if (ctx.method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((label) => labelJson(repo, label.name));
      return sendJson(ctx, 200, labels);
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] });
      if (repo.labels.has(name.toLowerCase())) return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] });
      const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(name.toLowerCase(), { name, color });
      return sendJson(ctx, 201, labelJson(repo, name));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  // ---- issues
  if (head === 'issues') {
    return handleIssues(ctx, repo, rest);
  }

  // ---- pulls
  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest);
  }

  return sendError(ctx, 404, 'Not Found');
}

async function handleContents(ctx: Ctx, repo: RepoRec, rest: string[]): Promise<void> {
  const path = rest.join('/');

  if (ctx.method === 'GET') {
    const refParam = ctx.query.get('ref');
    const commitSha = refParam !== null && refParam !== ''
      ? branchTip(repo, refParam) ?? (repo.objects.get(refParam)?.type === 'commit' ? refParam : null)
      : branchTip(repo, repo.defaultBranch);
    if (commitSha === null) return sendError(ctx, 404, 'Not Found');
    const tree = commitTree(repo, commitSha);
    if (tree === null) return sendError(ctx, 404, 'Not Found');
    if (path === '') {
      const entries = parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0)).map((entry) => dirEntryJson(repo, entry, ''));
      return sendJson(ctx, 200, entries);
    }
    const segments = path.split('/');
    const found = lookupPath(repo.objects, tree, segments);
    if (found === null) return sendError(ctx, 404, 'Not Found');
    if (found.mode === '40000') {
      const entries = parseTree(repo.objects.get(found.oid)?.data ?? Buffer.alloc(0)).map((entry) => dirEntryJson(repo, entry, path));
      return sendJson(ctx, 200, entries);
    }
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, fileJson(repo, path, found.oid, blob.data));
  }

  if (ctx.method === 'PUT' || ctx.method === 'DELETE') {
    const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
    if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : ctx.method === 'PUT' ? `Create ${path}` : `Delete ${path}`;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (ctx.method === 'PUT') {
      if (typeof body.content !== 'string') return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'content', code: 'missing_field' }] });
      const content = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
      const result = commitFileChange(repo, branch, path, content, message, expectedSha);
      if (!result.ok) {
        if (result.reason === 'stale') return sendJson(ctx, 409, { message: 'Conflict', errors: [{ resource: 'Content', field: 'sha', code: 'invalid' }] });
        return sendError(ctx, 404, 'Not Found');
      }
      const blob = repo.objects.get(result.blobSha!)!;
      return sendJson(ctx, result.created ? 201 : 200, {
        content: fileJson(repo, path, result.blobSha!, blob.data),
        commit: { sha: result.commitSha, message, url: '' },
      });
    }
    const result = commitFileChange(repo, branch, path, null, message, expectedSha);
    if (!result.ok) {
      if (result.reason === 'stale') return sendJson(ctx, 409, { message: 'Conflict', errors: [{ resource: 'Content', field: 'sha', code: 'invalid' }] });
      return sendError(ctx, 404, 'Not Found');
    }
    return sendJson(ctx, 200, { content: null, commit: { sha: result.commitSha, message, url: '' } });
  }

  return sendError(ctx, 404, 'Not Found');
}

function dirEntryJson(repo: RepoRec, entry: { mode: string; name: string; oid: string }, prefix: string): Record<string, unknown> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const blob = isDir ? null : repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: blob === null || blob === undefined ? 0 : blob.data.length,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
  };
}

function fileJson(repo: RepoRec, path: string, sha: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const base64 = data.toString('base64');
  const wrapped = base64.replace(/(.{60})/g, '$1\n') + (base64.length > 0 ? '\n' : '');
  return {
    type: 'file',
    encoding: 'base64',
    content: wrapped,
    size: data.length,
    name,
    path,
    sha,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
  };
}

async function handleIssues(ctx: Ctx, repo: RepoRec, rest: string[]): Promise<void> {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(ctx, issues.map((issue) => issueJson(repo, issue)), ctx.path);
      return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
      const labels = canonicalLabels(repo, body.labels);
      if (labels === null) return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
      const issue = createIssue(ctx.store, repo, { title, body: typeof body.body === 'string' ? body.body : '', labels });
      return sendJson(ctx, 201, issueJson(repo, issue));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(ctx, 404, 'Not Found');
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (issue === undefined) return sendError(ctx, 404, 'Not Found');
    if (ctx.method === 'GET') {
      return sendJson(ctx, 200, issueJsonText(repo, issue));
    }
    if (ctx.method === 'PATCH') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = canonicalLabels(repo, body.labels);
        if (labels === null) return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      repo.issueJsonCache.delete(issue.number);
      return sendJson(ctx, 200, issueJson(repo, issue));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return sendError(ctx, 404, 'Not Found');
    if (ctx.method === 'GET') {
      const page = paginate(ctx, issue.comments.map((comment) => commentJson(repo, issue, comment)), ctx.path);
      return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] });
      const comment = addComment(repo, issue, ctx.store.nextCommentId(), text);
      repo.issueJsonCache.delete(issue.number);
      return sendJson(ctx, 201, commentJson(repo, issue, comment));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  return sendError(ctx, 404, 'Not Found');
}

function normalizeBranchRef(value: string): string {
  let ref = value;
  const colon = ref.indexOf(':');
  if (colon >= 0 && !ref.startsWith('refs/')) ref = ref.slice(colon + 1);
  if (ref.startsWith('refs/heads/')) ref = ref.slice('refs/heads/'.length);
  return ref;
}

async function handlePulls(ctx: Ctx, repo: RepoRec, rest: string[]): Promise<void> {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const page = paginate(ctx, pulls.map((pull) => pullJson(repo, pull)), ctx.path);
      return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? normalizeBranchRef(body.head) : '';
      const base = typeof body.base === 'string' ? normalizeBranchRef(body.base) : '';
      const headSha = head === '' ? null : branchTip(repo, head);
      const baseSha = base === '' ? null : branchTip(repo, base);
      if (title === '' || headSha === null || baseSha === null) {
        return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
      }
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) {
        return sendJson(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: `A pull request already exists for ${head} into ${base}.` }] });
      }
      const pull = createPull(ctx.store, repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return sendJson(ctx, 201, pullJson(repo, pull));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(number);

  if (rest.length === 1 && ctx.method === 'GET') {
    if (pull === undefined) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, pullJson(repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'files' && ctx.method === 'GET') {
    if (pull === undefined) return sendError(ctx, 404, 'Not Found');
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    // After a merge the base branch has moved onto the merge commit; the PR's own diff is
    // measured from its recorded base, so prefer the snapshots once merged.
    const files = diffCommits(repo, pull.merged ? pull.baseSha : baseSha, headSha).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: '',
    }));
    const page = paginate(ctx, files, ctx.path);
    return sendJson(ctx, 200, page.items, page.linkHeader !== null ? { link: page.linkHeader } : {});
  }

  if (rest.length === 2 && rest[1] === 'merge' && ctx.method === 'PUT') {
    if (pull === undefined) return sendError(ctx, 404, 'Not Found');
    const body = parseJsonBody((await readBody(ctx.req)).toString('utf8'));
    if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
    const method = body.merge_method === 'squash' ? 'squash' : body.merge_method === 'rebase' ? 'rebase' : 'merge';
    const result = mergePull(repo, pull, method);
    if (!result.ok) return sendJson(ctx, 405, { message: 'Pull Request is not mergeable', documentation_url: '' });
    return sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return sendError(ctx, 404, 'Not Found');
}
