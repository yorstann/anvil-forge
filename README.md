# Anvil — a GitHub-compatible git forge in one Node process

![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/yorstann/anvil-forge/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/yorstann/anvil-forge/reward.svg)

Anvil is a standalone, GitHub-compatible git forge that runs as a single Node.js
process with no database, no UI and no git binary. From its own in-memory store
it serves, on one base URL:

- **git smart HTTP** — upload-pack protocol v2 and receive-pack v0 for clone,
  fetch and push at `/{owner}/{repo}.git`
- **the REST v3 API** under `/api/v3` — repositories, contents, labels, issues
  and pull requests (including squash merge)
- **the GraphQL v4 API** at `/api/graphql` — repository, issue and pull request
  queries, introspection and `createPullRequest`
- **a Model Context Protocol endpoint** at `/mcp` — JSON-RPC 2.0 over the
  Streamable HTTP transport, with tools that act on the same store as REST

Everything is implemented from scratch on the Node standard library: the git
object model (blobs, trees, commits, packfiles), the pkt-line wire codec, the
REST router, a small GraphQL executor for the served schema, and the MCP tool
surface.

## Running it

The forge is an entry for the make.fun bounty
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01).
In a trial it is started as `node main.ts` with `MAKEFUN_ENV_URL` set: it binds
an ephemeral port, registers that port with the environment, serves until the
environment says the trial is done, and exits 0.

## License

MIT — see [LICENSE](LICENSE).
