// store.ts — Anvil's in-memory store: repositories, git objects, issues, pull requests, labels and
// comments, plus the domain operations the REST, GraphQL, MCP and git surfaces share.

import {
  buildCommitBytes,
  flattenTree,
  hashObject,
  isAncestor,
  lookupPath,
  mergeBase,
  mergeTrees,
  parseCommit,
  revListExclusive,
  storeObject,
  updateTreePath,
  type ObjectMap,
} from './git.ts';

// ---------------------------------------------------------------- clock
// "Now" comes from MAKEFUN_TRIAL_NOW when the trial sets it, else the wall clock; a monotonic
// sequence is added so two records never share a timestamp and ordering is stable.

let clockBaseMs: number | null = null;
let clockSeq = 0;

export function nowMs(): number {
  if (clockBaseMs === null) {
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    let parsed = Number.NaN;
    if (raw !== '') {
      parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isNaN(parsed) && parsed < 1e12) parsed *= 1000; // epoch seconds
    }
    clockBaseMs = Number.isNaN(parsed) ? Date.now() : parsed;
  }
  clockSeq += 1;
  return clockBaseMs + clockSeq;
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

export function nowSec(): number {
  return Math.floor(nowMs() / 1000);
}

/** The forge's own commit identity (contents commits, merges). */
export function forgeIdent(): string {
  return `Anvil Forge <forge@anvil.invalid> ${nowSec()} +0000`;
}

// ---------------------------------------------------------------- records

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectMap;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  /** Serialized REST issue JSON cache (read workload), keyed by issue number. */
  issueJsonCache: Map<number, string>;
  /** Built pack bytes per fetch shape (clone workload), keyed by wants/depth/haves. */
  packCache: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, RepoRec>();
  private repoIdSeq = 100000;
  private issueIdSeq = 200000;
  private commentIdSeq = 300000;

  nextRepoId(): number {
    this.repoIdSeq += 1;
    return this.repoIdSeq;
  }

  nextIssueId(): number {
    this.issueIdSeq += 1;
    return this.issueIdSeq;
  }

  nextCommentId(): number {
    this.commentIdSeq += 1;
    return this.commentIdSeq;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function createRepo(store: Store, owner: string, name: string, options: { description?: string; isPrivate?: boolean }): RepoRec | null {
  const key = repoKey(owner, name);
  if (store.repos.has(key)) return null;
  const repo: RepoRec = {
    id: store.nextRepoId(),
    owner,
    name,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: nowIso(),
    issueJsonCache: new Map(),
    packCache: new Map(),
  };
  store.repos.set(key, repo);
  return repo;
}

export function getRepo(store: Store, owner: string, name: string): RepoRec | null {
  return store.repos.get(repoKey(owner, name)) ?? null;
}

export function deleteRepo(store: Store, owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

export function listRepos(store: Store, owner: string): RepoRec[] {
  return [...store.repos.values()].filter((repo) => repo.owner.toLowerCase() === owner.toLowerCase()).sort((a, b) => a.id - b.id);
}

export function findRepoById(store: Store, id: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

// ---------------------------------------------------------------- refs and trees

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function commitTree(repo: RepoRec, commitSha: string): string | null {
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Sorted branch names. */
export function branchNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
}

// ---------------------------------------------------------------- contents commits

export type FileChangeResult =
  | { ok: true; commitSha: string; blobSha: string | null; created: boolean }
  | { ok: false; reason: 'stale' | 'missing' | 'no-branch' };

/**
 * Create or delete the file at `path` on `branch` as a new commit (the contents API's engine).
 * `content === null` deletes. A branch that does not exist yet is created from the default
 * branch's tip (or as a root commit in an empty repository).
 */
export function commitFileChange(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  expectedBlobSha?: string,
): FileChangeResult {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null) {
    const fallback = branchTip(repo, repo.defaultBranch);
    if (fallback !== null) tip = fallback;
  }
  const baseTree = tip === null ? null : commitTree(repo, tip);
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { ok: false, reason: 'missing' };
  const existing = baseTree === null ? null : lookupPath(repo.objects, baseTree, segments);
  if (content === null) {
    if (existing === null || existing.mode === '40000') return { ok: false, reason: 'missing' };
    if (expectedBlobSha !== undefined && expectedBlobSha !== existing.oid) return { ok: false, reason: 'stale' };
  } else if (expectedBlobSha !== undefined) {
    const current = existing !== null && existing.mode !== '40000' ? existing.oid : null;
    if (current !== expectedBlobSha && !(current === null && expectedBlobSha === '0'.repeat(40))) {
      return { ok: false, reason: 'stale' };
    }
  }
  let blobSha: string | null = null;
  let newTree: string;
  if (content === null) {
    newTree = updateTreePath(repo.objects, baseTree, segments, null);
  } else {
    blobSha = storeObject(repo.objects, 'blob', content);
    newTree = updateTreePath(repo.objects, baseTree, segments, { mode: '100644', oid: blobSha });
  }
  const ident = forgeIdent();
  const commit = buildCommitBytes({
    tree: newTree,
    parents: tip === null ? [] : [tip],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = storeObject(repo.objects, 'commit', commit);
  repo.refs.set(ref, commitSha);
  return { ok: true, commitSha, blobSha, created: existing === null };
}

// ---------------------------------------------------------------- issues and comments

export function createIssue(store: Store, repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const at = nowIso();
  const issue: IssueRec = {
    id: store.nextIssueId(),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdAt: at,
    updatedAt: at,
  };
  repo.issues.set(number, issue);
  repo.issueJsonCache.delete(number);
  return issue;
}

export function addComment(repo: RepoRec, issue: IssueRec, id: number, body: string): CommentRec {
  const comment: CommentRec = { id, body, createdAt: nowIso() };
  issue.comments.push(comment);
  issue.updatedAt = nowIso();
  return comment;
}

// ---------------------------------------------------------------- pull requests

export function createPull(
  store: Store,
  repo: RepoRec,
  input: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
): PullRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const at = nowIso();
  const pull: PullRec = {
    id: store.nextIssueId(),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
    headSha: input.headSha,
    baseSha: input.baseSha,
    createdAt: at,
    updatedAt: at,
  };
  repo.pulls.set(number, pull);
  return pull;
}

export interface PrFileEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

/** The file diff between two commits' trees (the pulls/{n}/files surface). */
export function diffCommits(repo: RepoRec, baseSha: string, headSha: string): PrFileEntry[] {
  const baseTree = commitTree(repo, baseSha);
  const headTree = commitTree(repo, headSha);
  const baseFlat = baseTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, baseTree);
  const headFlat = headTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, headTree);
  const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort();
  const files: PrFileEntry[] = [];
  for (const path of paths) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    const baseData = base === undefined ? null : (repo.objects.get(base.oid)?.data ?? Buffer.alloc(0));
    const headData = head === undefined ? null : (repo.objects.get(head.oid)?.data ?? Buffer.alloc(0));
    const additions = headData === null ? 0 : lineCount(headData);
    const deletions = baseData === null ? 0 : lineCount(baseData);
    files.push({
      filename: path,
      status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-mergeable' | 'missing-ref' };

/** Merge a pull request into its base branch (squash, merge commit, or rebase). */
export function mergePull(repo: RepoRec, pull: PullRec, method: 'merge' | 'squash' | 'rebase'): MergeResult {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'not-mergeable' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === null || headTip === null) return { ok: false, reason: 'missing-ref' };
  if (headTip === baseTip || isAncestor(repo.objects, headTip, baseTip)) return { ok: false, reason: 'not-mergeable' };
  const baseCommit = mergeBase(repo.objects, baseTip, headTip);
  const baseTree = baseCommit === null ? null : commitTree(repo, baseCommit);
  const oursTree = commitTree(repo, baseTip);
  const theirsTree = commitTree(repo, headTip);
  if (oursTree === null || theirsTree === null) return { ok: false, reason: 'missing-ref' };

  let newTip: string;
  if (method === 'rebase') {
    const commits = revListExclusive(repo.objects, headTip, [baseTip]).reverse();
    let current = baseTip;
    let currentTree = oursTree;
    for (const commitSha of commits) {
      const info = parseCommit(repo.objects.get(commitSha)!.data);
      const parentTree = info.parents.length > 0 ? commitTree(repo, info.parents[0]!) : null;
      const merged = mergeTrees(repo.objects, parentTree, currentTree, info.tree);
      if (merged === null) return { ok: false, reason: 'conflict' };
      const bytes = buildCommitBytes({
        tree: merged,
        parents: [current],
        author: info.author,
        committer: forgeIdent(),
        message: info.message,
      });
      current = storeObject(repo.objects, 'commit', bytes);
      currentTree = merged;
    }
    newTip = current;
  } else {
    const mergedTree = mergeTrees(repo.objects, baseTree, oursTree, theirsTree);
    if (mergedTree === null) return { ok: false, reason: 'conflict' };
    const ident = forgeIdent();
    const bytes =
      method === 'squash'
        ? buildCommitBytes({
            tree: mergedTree,
            parents: [baseTip],
            author: ident,
            committer: ident,
            message: pull.body === '' ? `${pull.title}\n` : `${pull.title}\n\n${pull.body}\n`,
          })
        : buildCommitBytes({
            tree: mergedTree,
            parents: [baseTip, headTip],
            author: ident,
            committer: ident,
            message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
          });
    newTip = storeObject(repo.objects, 'commit', bytes);
  }

  repo.refs.set(`refs/heads/${pull.baseRef}`, newTip);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = newTip;
  pull.updatedAt = nowIso();
  return { ok: true, sha: newTip };
}

/** Whether an open pull request's head merges cleanly into its base (GraphQL mergeable). */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  if (headTip === baseTip || isAncestor(repo.objects, headTip, baseTip)) return 'UNKNOWN';
  const baseCommit = mergeBase(repo.objects, baseTip, headTip);
  const baseTree = baseCommit === null ? null : commitTree(repo, baseCommit);
  const oursTree = commitTree(repo, baseTip);
  const theirsTree = commitTree(repo, headTip);
  if (oursTree === null || theirsTree === null) return 'UNKNOWN';
  return mergeTrees(repo.objects, baseTree, oursTree, theirsTree) === null ? 'CONFLICTING' : 'MERGEABLE';
}

export { hashObject };
