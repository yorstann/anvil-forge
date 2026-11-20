// githttp.ts — git smart HTTP: ref advertisement (v0 and v2), ls-refs, fetch (v0 and v2,
// shallow/deepen aware) and receive-pack with fast-forward enforcement and report-status.

import {
  PktReader,
  ZERO_OID,
  isAncestor,
  parseCommit,
  parseTree,
  pktFlush,
  pktLine,
  readPack,
  sidebandPacket,
  storeObject,
  writePack,
  type GitObject,
  type ObjectMap,
} from './git.ts';
import { authOk, readBody, sendRaw, type Ctx } from './http.ts';
import { getRepo, type RepoRec } from './store.ts';

const AGENT = 'anvil/1.0.0';
const ZERO = ZERO_OID;

function textError(ctx: Ctx, status: number, message: string): void {
  sendRaw(ctx, status, Buffer.from(`${message}\n`, 'utf8'), 'text/plain; charset=utf-8');
}

/** Peel a (possibly annotated) tag object down to the object it ultimately names. */
function peelToCommit(objects: ObjectMap, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (match === null) return current;
    current = match[1]!;
  }
  return current;
}

function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- advertisement

function advertisementV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:${headTarget(repo)} agent=${AGENT} object-format=sha1`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${caps}`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
  };
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO;
  line(headOid, 'HEAD');
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    line(oid, name);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      parts.push(pktLine(`${peelToCommit(repo.objects, oid)} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------- fetch computation

export interface FetchComputation {
  objectIds: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must deliver: everything reachable from the wants that the haves do not
 * already cover, cut at the requested depth. The haves' closure does not cross a shallow
 * boundary commit's parents (the client holds the boundary commit, not its history), and the
 * depth budget counts generations from the wants, boundary commits included.
 */
export function computeFetch(
  objects: ObjectMap,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  depth: number | null,
): FetchComputation {
  const shallowSet = new Set(shallowLines);
  // The object closure of the haves, not crossing boundary commits' parents.
  const excluded = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (excluded.has(oid)) continue;
      const object = objects.get(oid);
      if (object === undefined) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!shallowSet.has(oid)) stack.push(...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = peelToCommit(objects, oid);
        if (target !== oid) stack.push(target);
      }
    }
  }
  const includedCommits = new Set<string>();
  const processedAllowance = new Map<string, number>();
  const boundary = new Set<string>();
  const queue: Array<[string, number]> = [];
  const push = (oid: string, allowance: number): void => {
    if (excluded.has(oid)) return;
    const previous = processedAllowance.get(oid);
    if (previous !== undefined && previous >= allowance) return;
    queue.push([oid, allowance]);
  };
  const tagObjects: string[] = [];
  const wantCommit = (oid: string): string | null => {
    const object = objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      tagObjects.push(oid);
      const target = peelToCommit(objects, oid);
      const targetObject = objects.get(target);
      return targetObject !== undefined && targetObject.type === 'commit' ? target : null;
    }
    return null;
  };

  for (const want of wants) {
    const commit = wantCommit(want);
    if (commit !== null) push(commit, depth ?? Number.POSITIVE_INFINITY);
  }
  if (shallowLines.length > 0) {
    // Distance of every commit from the nearest want (the want itself is generation 1), so a
    // boundary commit's parents inherit the depth budget that remains beyond the boundary.
    const distance = new Map<string, number>();
    const distanceQueue: Array<[string, number]> = [];
    for (const want of wants) {
      const commit = wantCommit(want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 1);
        distanceQueue.push([commit, 1]);
      }
    }
    while (distanceQueue.length > 0) {
      const [oid, dist] = distanceQueue.shift()!;
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          distanceQueue.push([parent, dist + 1]);
        }
      }
    }
    for (const boundaryCommit of shallowLines) {
      const object = objects.get(boundaryCommit);
      if (object === undefined || object.type !== 'commit') continue;
      const dist = distance.get(boundaryCommit) ?? 1;
      const allowance = depth === null ? Number.POSITIVE_INFINITY : depth - dist;
      if (allowance < 1) continue;
      for (const parent of parseCommit(object.data).parents) push(parent, allowance);
    }
  }
  while (queue.length > 0) {
    const [oid, allowance] = queue.shift()!;
    const previous = processedAllowance.get(oid);
    if (previous !== undefined && previous >= allowance) continue;
    processedAllowance.set(oid, allowance);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    includedCommits.add(oid);
    const parents = parseCommit(object.data).parents;
    if (allowance <= 1) {
      if (parents.length > 0) boundary.add(oid);
    } else {
      boundary.delete(oid);
      for (const parent of parents) push(parent, allowance - 1);
    }
  }
  const unshallow: string[] = [];
  if (shallowLines.length > 0) {
    for (const boundaryCommit of shallowLines) {
      const object = objects.get(boundaryCommit);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0 || parents.some((parent) => includedCommits.has(parent))) unshallow.push(boundaryCommit);
    }
  }
  // Object closure of the included commits (and any tag wants), minus what the client has.
  const included = new Set<string>();
  const stack: string[] = [...includedCommits, ...tagObjects];
  for (const want of wants) {
    const object = objects.get(want);
    if (object !== undefined && object.type !== 'commit' && object.type !== 'tag') stack.push(want);
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (included.has(oid) || excluded.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    included.add(oid);
    if (object.type === 'commit') stack.push(parseCommit(object.data).tree);
    else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = peelToCommit(objects, oid);
      if (target !== oid) stack.push(target);
    }
  }
  // Deterministic order: tags, commits (BFS order), then the rest in discovery order.
  const ordered: string[] = [];
  for (const oid of tagObjects) if (included.has(oid)) ordered.push(oid);
  for (const oid of includedCommits) if (included.has(oid)) ordered.push(oid);
  for (const oid of included) if (!includedCommits.has(oid) && !tagObjects.includes(oid)) ordered.push(oid);
  return { objectIds: ordered, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

function packForFetch(repo: RepoRec, computation: FetchComputation, cacheKey: string): Buffer {
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const objects: GitObject[] = [];
  for (const oid of computation.objectIds) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, pack);
  return pack;
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const SIZE = 32768;
  if (pack.length === 0) {
    chunks.push(sidebandPacket(1, Buffer.alloc(0)));
    return chunks;
  }
  for (let offset = 0; offset < pack.length; offset += SIZE) {
    chunks.push(sidebandPacket(1, pack.subarray(offset, Math.min(pack.length, offset + SIZE))));
  }
  return chunks;
}

// ---------------------------------------------------------------- request handling

export async function handleGit(ctx: Ctx): Promise<void> {
  const segments = ctx.path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return textError(ctx, 404, 'Not Found');
  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return textError(ctx, 404, 'Not Found');
  const repoName = repoSegment.slice(0, -'.git'.length);
  const tail = segments.slice(2);

  if (!authOk(ctx.req)) return textError(ctx, 401, 'Authentication required');
  const repo = getRepo(ctx.store, owner, repoName);
  if (repo === null) return textError(ctx, 404, 'Repository not found');

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return textError(ctx, 400, 'Unknown service');
    const protocol = ctx.req.headers['git-protocol'] ?? '';
    if (service === 'git-upload-pack' && protocol.includes('version=2')) {
      return sendRaw(ctx, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
    }
    return sendRaw(ctx, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && ctx.method === 'POST') {
    const body = await readBody(ctx.req);
    return handleUploadPack(ctx, repo, body);
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && ctx.method === 'POST') {
    const body = await readBody(ctx.req);
    return handleReceivePack(ctx, repo, body);
  }

  return textError(ctx, 404, 'Not Found');
}

function handleUploadPack(ctx: Ctx, repo: RepoRec, body: Buffer): void {
  try {
    const reader = new PktReader(body);
    const first = reader.next();
    if (first === null || first.kind !== 'data') return textError(ctx, 400, 'Bad request');
    const firstLine = first.payload.toString('utf8');
    if (firstLine.startsWith('command=')) {
      const command = firstLine.trim().slice('command='.length);
      // Command arguments up to the delimiter, then arguments to the flush.
      const args: string[] = [];
      let packet = reader.next();
      while (packet !== null && packet.kind === 'data') {
        args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
        packet = reader.next();
      }
      if (packet !== null && packet.kind === 'delim') {
        packet = reader.next();
        while (packet !== null && packet.kind === 'data') {
          args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
          packet = reader.next();
        }
      }
      if (command === 'ls-refs') return sendRaw(ctx, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
      if (command === 'fetch') return sendRaw(ctx, 200, fetchResponseV2(repo, args), 'application/x-git-upload-pack-result');
      return textError(ctx, 400, `Unknown command ${command}`);
    }
    // v0 fetch: the first packet is the first want line; the reader continues from there.
    return sendRaw(ctx, 200, fetchResponseV0(repo, body), 'application/x-git-upload-pack-result');
  } catch {
    return textError(ctx, 400, 'Bad request');
  }
}

function lsRefsResponse(repo: RepoRec, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const passes = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (passes('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!passes(name)) continue;
    const oid = repo.refs.get(name)!;
    let suffix = '';
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') suffix = ` peeled:${peelToCommit(repo.objects, oid)}`;
    }
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg === 'done') parsed.done = true;
    else if (arg.startsWith('deepen ')) {
      const depth = Number(arg.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) parsed.depth = Math.trunc(depth);
    }
  }
  return parsed;
}

function commonHaves(repo: RepoRec, haves: readonly string[], wants: readonly string[]): string[] {
  const common: string[] = [];
  const wantSet = new Set(wants);
  void wantSet;
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (object !== undefined && object.type === 'commit' && !common.includes(have)) common.push(have);
  }
  return common;
}

function fetchResponseV2(repo: RepoRec, args: readonly string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const computation = computeFetch(repo.objects, parsed.wants, parsed.haves, parsed.shallow, parsed.depth);
  const cacheKey = `v2|${[...parsed.wants].sort().join(',')}|${[...parsed.haves].sort().join(',')}|${[...parsed.shallow].sort().join(',')}|${parsed.depth ?? ''}`;
  const pack = packForFetch(repo, computation, cacheKey);
  const parts: Buffer[] = [];
  // acknowledgments: only while the client is still negotiating (no `done` yet) — a client
  // that sent `done` expects the packfile section next.
  if (!parsed.done) {
    parts.push(pktLine('acknowledgments\n'));
    const common = commonHaves(repo, parsed.haves, parsed.wants);
    if (common.length > 0) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktFlush());
  }
  // shallow-info
  if (parsed.depth !== null || parsed.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of computation.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of computation.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let packet = reader.next();
  // Section 1: wants, shallow, deepen — terminated by a flush.
  while (packet !== null && packet.kind === 'data') {
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      wants.push((space < 0 ? rest : rest.slice(0, space)).trim());
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const parsed = Number(line.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) depth = Math.trunc(parsed);
    }
    packet = reader.next();
  }
  // Section 2: haves and done — terminated by a flush.
  packet = reader.next();
  while (packet !== null && packet.kind === 'data') {
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    packet = reader.next();
  }
  const computation = computeFetch(repo.objects, wants, haves, shallow, depth);
  const cacheKey = `v0|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
  const pack = packForFetch(repo, computation, cacheKey);
  const parts: Buffer[] = [];
  for (const oid of computation.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of computation.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = commonHaves(repo, haves, wants);
  if (common.length > 0) {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(...sidebandChunks(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: Ctx, repo: RepoRec, body: Buffer): void {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let packet = reader.next();
  let first = true;
  while (packet !== null && packet.kind === 'data') {
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const fields = line.split(' ');
    if (fields.length === 3 && /^[0-9a-f]{40}$/.test(fields[0]!) && /^[0-9a-f]{40}$/.test(fields[1]!)) {
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
    }
    packet = reader.next();
  }
  const pack = reader.rest();
  let unpackOk = true;
  let unpackDetail = '';
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const object of read.objects) storeObject(repo.objects, object.type, object.data);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack error';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.newOid === ZERO) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
      results.push({ ref: command.ref, ok: false, reason: 'bad object' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (current !== undefined && command.ref.startsWith('refs/heads/')) {
      if (!isAncestor(repo.objects, current, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (results.some((result) => result.ok)) repo.packCache.clear();

  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(pktFlush());
  const reportBytes = Buffer.concat(report);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  if (useSideband) {
    const chunks: Buffer[] = [];
    const SIZE = 32768;
    for (let offset = 0; offset < reportBytes.length; offset += SIZE) {
      chunks.push(sidebandPacket(1, reportBytes.subarray(offset, Math.min(reportBytes.length, offset + SIZE))));
    }
    chunks.push(pktFlush());
    return sendRaw(ctx, 200, Buffer.concat(chunks), 'application/x-git-receive-pack-result');
  }
  return sendRaw(ctx, 200, reportBytes, 'application/x-git-receive-pack-result');
}
