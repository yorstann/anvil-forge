// git.ts — Anvil's git object model: SHA-1 objects, trees, commits, packs and pkt-lines.
// Plain git formats throughout (the suite's client recomputes every hash), standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export type ObjectMap = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a typed payload: sha1("<type> <size>\0" + bytes). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object (idempotent) and return its id. */
export function storeObject(map: ObjectMap, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!map.has(oid)) map.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeTree(map: ObjectMap, entries: readonly TreeEntry[]): string {
  return storeObject(map, 'tree', buildTree(entries));
}

/** Flatten a tree into path -> blob entry (recursive). */
export function flattenTree(map: ObjectMap, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = map.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(map, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build nested trees from a flat path map; returns the root tree id (the empty tree for no paths). */
export function buildTreeFromFlat(map: ObjectMap, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeTree(map, entries);
  };
  return build(root);
}

/**
 * Return a new root tree with the leaf at `segments` set to `leaf` (or removed when leaf is null),
 * creating intermediate trees. `rootOid` may be null (empty tree). Existing trees are never mutated.
 */
export function updateTreePath(map: ObjectMap, rootOid: string | null, segments: readonly string[], leaf: { mode: string; oid: string } | null): string {
  const entries: TreeEntry[] = rootOid === null ? [] : parseTree(map.get(rootOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = segments as [string, ...string[]];
  const index = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    const kept = entries.filter((entry) => entry.name !== head);
    if (leaf !== null) kept.push({ mode: leaf.mode, name: head, oid: leaf.oid });
    return storeTree(map, kept);
  }
  const existing = index >= 0 ? entries[index] : undefined;
  const childOid = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
  const newChild = updateTreePath(map, childOid, rest, leaf);
  const kept = entries.filter((entry) => entry.name !== head);
  // An emptied subtree disappears (git trees never hold empty directories via this path).
  const childTree = map.get(newChild);
  if (childTree !== undefined && childTree.data.length > 0) kept.push({ mode: '40000', name: head, oid: newChild });
  return storeTree(map, kept);
}

/** The entry at a path inside a tree, or null. */
export function lookupPath(map: ObjectMap, rootOid: string, segments: readonly string[]): { mode: string; oid: string } | null {
  let current = rootOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = map.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const split = data.indexOf('\n\n');
  const head = split < 0 ? data.toString('utf8') : data.toString('utf8', 0, split);
  const message = split < 0 ? '' : data.toString('utf8', split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitBytes(options: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${options.tree}`];
  for (const parent of options.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${options.author}`);
  lines.push(`committer ${options.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${options.message}`, 'utf8');
}

/** Split an ident line ("Name <email> 1700000000 +0000") into parts. */
export function parseIdent(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line.trim(), email: '', timestamp: 0 };
  return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]) };
}

/** All commit ids reachable from `tip` (inclusive), following parents. Missing objects stop a walk. */
export function commitAncestors(map: ObjectMap, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(map: ObjectMap, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitAncestors(map, tip).has(ancestor);
}

/** A merge base of two commits (a common ancestor; the deepest one found by BFS), or null. */
export function mergeBase(map: ObjectMap, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = commitAncestors(map, a);
  if (ancestorsA.has(b)) return b;
  if (commitAncestors(map, b).has(a)) return a;
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = map.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Commits reachable from `tip` but not from any of `excludeTips`, newest first (BFS order). */
export function revListExclusive(map: ObjectMap, tip: string, excludeTips: readonly string[]): string[] {
  const excluded = new Set<string>();
  for (const exclude of excludeTips) for (const oid of commitAncestors(map, exclude)) excluded.add(oid);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid) || excluded.has(oid)) continue;
    seen.add(oid);
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return out;
}

/** Every object id reachable from the given root objects (commits walk trees and parents). */
export function reachableObjects(map: ObjectMap, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = map.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1]!);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- three-way tree merge

/**
 * Merge two trees against a base tree. Returns the merged tree id, or null on conflict.
 * Blob rule: a path changed on only one side takes that side; changed identically on both sides is
 * fine; changed differently on both sides (including add/add with different bytes) conflicts.
 * Subtrees merge recursively.
 */
export function mergeTrees(map: ObjectMap, baseOid: string | null, oursOid: string, theirsOid: string): string | null {
  if (oursOid === theirsOid) return oursOid;
  if (baseOid !== null && baseOid === oursOid) return theirsOid;
  if (baseOid !== null && baseOid === theirsOid) return oursOid;
  const base = new Map<string, TreeEntry>((baseOid === null ? [] : parseTree(map.get(baseOid)?.data ?? Buffer.alloc(0))).map((e) => [e.name, e]));
  const ours = new Map<string, TreeEntry>(parseTree(map.get(oursOid)?.data ?? Buffer.alloc(0)).map((e) => [e.name, e]));
  const theirs = new Map<string, TreeEntry>(parseTree(map.get(theirsOid)?.data ?? Buffer.alloc(0)).map((e) => [e.name, e]));
  const names = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged: TreeEntry[] = [];
  const same = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean =>
    x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.mode === y.mode && x.oid === y.oid;
  for (const name of names) {
    const b = base.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    if (same(o, t)) {
      if (o !== undefined) merged.push(o);
      continue;
    }
    if (same(b, o)) {
      if (t !== undefined) merged.push(t);
      continue;
    }
    if (same(b, t)) {
      if (o !== undefined) merged.push(o);
      continue;
    }
    // Both sides changed the path differently: recurse when both are trees, else conflict.
    if (o !== undefined && t !== undefined && o.mode === '40000' && t.mode === '40000') {
      const sub = mergeTrees(map, b !== undefined && b.mode === '40000' ? b.oid : null, o.oid, t.oid);
      if (sub === null) return null;
      merged.push({ mode: '40000', name, oid: sub });
      continue;
    }
    return null;
  }
  return storeTree(map, merged);
}

// ---------------------------------------------------------------- packs

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

function readVarint(data: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = data[at]!;
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, offset: at };
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    const read = readVarint(delta, offset);
    offset = read.offset;
    return read.value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) { copyOffset |= delta[offset]! << (8 * bit); offset += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) { copySize |= delta[offset]! << (8 * bit); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackReadResult {
  objects: GitObject[];
  count: number;
}

/**
 * Parse a pack (plain, OFS-delta and REF-delta objects). REF-delta bases not in the pack are
 * resolved through `resolveBase`. Returns the reconstructed objects in pack order.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = Buffer.from(sha1Hex(pack.subarray(0, pack.length - 20)), 'hex');
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  let offset = 12;
  interface RawEntry {
    type: ObjType;
    data?: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { type: ID_TYPES[typeId] ?? 'blob', offset: entryOffset };
    if (typeId === 6) {
      // OFS-delta: a negative offset varint back to the base object.
      let back = pack[offset]!;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset]!;
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
      entry.type = 'blob'; // placeholder; resolved below
    } else if (typeId === 7) {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      entry.type = 'blob';
    }
    // Node's inflate with {info: true} reports how many compressed bytes the stream consumed.
    const inflated = inflateSync(pack.subarray(offset, pack.length - 20), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    entry.data = inflated.buffer;
    raw.push(entry);
    byOffset.set(entryOffset, raw.length - 1);
    offset += inflated.engine.bytesWritten;
  }
  // Resolve deltas.
  const resolved: Array<GitObject | null> = raw.map(() => null);
  const resolveAt = (index: number): GitObject => {
    const existing = resolved[index];
    if (existing !== null) return existing;
    const entry = raw[index]!;
    let object: GitObject;
    if (entry.baseOffset !== undefined) {
      const baseIndex = byOffset.get(entry.baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolveAt(baseIndex);
      object = { type: base.type, data: applyDelta(base.data, entry.data!) };
    } else if (entry.baseOid !== undefined) {
      let base: GitObject | undefined;
      for (let i = 0; i < raw.length; i += 1) {
        if (raw[i]!.baseOffset === undefined && raw[i]!.baseOid === undefined) {
          const candidate = resolveAt(i);
          if (hashObject(candidate.type, candidate.data) === entry.baseOid) { base = candidate; break; }
        }
      }
      if (base === undefined) base = resolveBase?.(entry.baseOid);
      if (base === undefined) throw new Error('ref-delta base not available');
      object = { type: base.type, data: applyDelta(base.data, entry.data!) };
    } else {
      object = { type: entry.type, data: entry.data! };
    }
    resolved[index] = object;
    return object;
  };
  const objects: GitObject[] = [];
  for (let i = 0; i < raw.length; i += 1) objects.push(resolveAt(i));
  return { objects, count };
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** A sequential reader over a complete request body buffer. */
export class PktReader {
  private buffer: Buffer;
  private offset = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next packet, or null when the buffer is exhausted (or malformed). */
  next(): PktPacket | null {
    if (this.offset + 4 > this.buffer.length) return null;
    const header = this.buffer.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(header)) return null;
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length < 4 || this.offset + length > this.buffer.length) return null;
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** The unread remainder (the pack bytes after a receive-pack command list). */
  rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }

  get position(): number {
    return this.offset;
  }
}
