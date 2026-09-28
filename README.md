# tla-check

Finds top-level `await` reachable from a package's `require()`-able entry points, before Node throws `ERR_REQUIRE_ASYNC_MODULE` at your users.

```sh
$ npx tla-check node_modules/temp-dir
temp-dir@3.0.0
  . ((direct target)): FAILS require() — top-level await found
    at file:///.../node_modules/temp-dir/index.js:4:27
      const temporaryDirectory = await fs.realpath(os.tmpdir());
    chain: file:///.../node_modules/temp-dir/index.js
```

## Why

Node 22.12+ and 24 let CommonJS `require()` synchronously load an ES module —
but if anything in that module's *transitive* import graph has a top-level
`await`, `require()` throws `ERR_REQUIRE_ASYNC_MODULE` instead. The await is
often several `import`/`export ... from` hops deep in a dependency, not in the
package you actually required.

This has broken real projects on upgrade, each time as a surprise at runtime
rather than at publish time:

- **node-lru-cache #397** — jsdom's CJS `require()` chain pulled in
  `@asamuzakjp/css-color` → `lru-cache`, whose ESM build added a top-level
  await. The reporter's traceback: `require() cannot be used on an ESM graph
  with top-level await. Use import() instead.` Root cause several hops away,
  in `tempy@3.1.0` → `temp-dir@3.0.0`, whose entire source is `const
  temporaryDirectory = await fs.realpath(os.tmpdir());`.
- **prettier #16930** — `yarn test` failed on Node 22.12 for the same reason,
  traced to that identical `temp-dir` line.
- **webpack-cli #4340** — "Up until now this was behaving correctly because
  `ERR_REQUIRE_ASYNC_MODULE` for a top-level-await config file... does not get
  caught" by webpack-cli's existing `ERR_REQUIRE_ESM` fallback.
- **firebase-tools #8054** — deployment broke on Node 22.12.0 ("`require(esm)`
  is now enabled by default") from a `require()` call inside
  `firebase-functions`.
- **angular-cli #30286** — the CLI's builder loader caught `ERR_REQUIRE_ESM`
  but not the new `ERR_REQUIRE_ASYNC_MODULE`, so ESM builders with top-level
  await stopped loading on Node ≥ 20.19.

Neither of the two tools people already run for package-shape problems catches
this:

**Measured:** built a package whose `require()`-able entry is ESM with a
top-level await (`await new Promise(...)`), then:

```
$ npx publint@0.3.24 .
Running publint v0.3.24 for temp-dir...
Packing files with `npm pack`...
Linting...
All good!

$ npx @arethetypeswrong/cli@latest temp-dir-3.0.0.tgz
⚠️ A require call resolved to an ESM JavaScript file, which is an error in
Node and some bundlers. CommonJS consumers will need to use a dynamic import.
```

publint says nothing. arethetypeswrong's warning looks relevant but is not:
it fires identically for *any* ESM package required from CJS, with or without
a top-level await — confirmed by running it against an otherwise-identical
fixture with the `await` removed, which produced byte-for-byte the same
warning. On Node 22.12+/24, an ESM package with no top-level await in its
graph loads via `require()` just fine; arethetypeswrong can't tell the two
cases apart, so it can't tell you whether your specific package actually
breaks.

Node itself has a runtime diagnostic: `--experimental-print-required-tla`
(confirmed present in `node --help` on Node 24.20.0). It is not a static
check — verified by running it: it only reports anything if your program
actually calls `require()` on the failing module and the call throws; it
hands back the locations via a non-enumerable `topLevelAwaitLocations`
property on the thrown error, one `require()` call at a time. It can't tell
you, before you publish or before you upgrade Node, whether *any* of your
package's entry points or export conditions would break — only whether the
one `require()` call you just made did.

## Installation

```sh
npm install --save-dev tla-check
```

Node >= 20.6 to run `tla-check` itself (needs `import.meta.resolve`). The
packages it checks can target any Node version — that's the point.

## Usage

### CLI

```sh
npx tla-check                  # check the package in the current directory
npx tla-check ./path/to/pkg
npx tla-check --installed      # check every installed dependency instead
npx tla-check --json ./pkg     # machine-readable output
npx tla-check --conditions browser ./pkg
```

### Library

```ts
import { checkPackage } from 'tla-check';

const report = await checkPackage('./path/to/pkg');
for (const entry of report.entries) {
  if (entry.status === 'top-level-await') {
    console.log(`${entry.specifier} can't be require()d:`);
    for (const { location, chain } of entry.awaits) {
      console.log(`  ${location.url}:${location.line} via ${chain.map((c) => c.url).join(' -> ')}`);
    }
  }
}
```

## Reference

### `checkPackage(dir, options?)`

Checks every entry point `require()` can reach in the package at `dir`
(its `exports` map — following the `require`/`node`/`default` conditions the
way Node resolves them for `require()`, patterns included — or `main` when
there is no `exports` map). Returns a `Promise<PackageReport>`.

### `checkInstalled(dir, options?)`

Walks `dir`'s `node_modules` for every package listed in `dependencies`,
`devDependencies`, `optionalDependencies` and `peerDependencies`, and runs
`checkPackage` on each. Returns a `Promise<InstalledReport>`.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `conditions` | `string[]` | `[]` | Extra export conditions to treat as active, beyond `node`, `require` and `default`. |

### `PackageReport`

| Field | Type | Description |
| --- | --- | --- |
| `entries` | `EntryResult[]` | One per require()-able subpath. |
| `clean` | `boolean` | `true` only if every entry is `ok`. |
| `hasFindings` | `boolean` | `true` if any entry is a confirmed `top-level-await` finding. |
| `fatalError` | `string?` | Set if the package itself couldn't be read at all. |

### `EntryResult.status`

| Status | Meaning |
| --- | --- |
| `ok` | `require()` would succeed. |
| `top-level-await` | `require()` would throw `ERR_REQUIRE_ASYNC_MODULE`. `awaits` lists every location found, each with its `chain` from the entry point. |
| `unresolved` | A specifier in the graph couldn't be resolved (missing dependency, blocked subpath, entry file doesn't exist). Not claimed as `ok` or as a finding — genuinely unknown. |
| `unsupported` | Reached a file type this tool doesn't analyse (see Limitations). |

### CLI flags

| Flag | Description |
| --- | --- |
| `[dir]` | Package (or project, with `--installed`) to check. Default: cwd. |
| `--installed` | Check every installed dependency of the project at `dir` instead of `dir` itself. |
| `--conditions <list>` | Extra conditions, comma-separated or repeated. |
| `--json` | Machine-readable output. |

Exit codes: `0` every entry `ok`, `1` at least one confirmed `top-level-await`
finding, `2` couldn't analyse (bad `package.json`, missing directory, or every
non-finding entry left `unresolved`/`unsupported`).

## How it works

For each entry point, `tla-check` walks the ESM import graph the way `require()`
does: it does **not** re-resolve every hop with the `require` condition. An
ESM `import`/`export ... from` inside that graph resolves using the `import`
condition, even though the whole graph was reached via `require()` — verified
by building a package with different `import`/`require` export targets one
level down and observing which one a real `require()` call actually returns.
Only the entry point itself is resolved with `require`/`node`/`default`.

Given that, transitive resolution is delegated to `import.meta.resolve`
(Node's own resolver, run with `--experimental-import-meta-resolve` so its
`parent` argument is honored — without that flag it is silently ignored and
resolution falls back to the current working directory, which was confirmed
by testing) rather than reimplemented. Only entry-point resolution (`exports`
map matching against `require`/`node`/`default`, subpath patterns, and the
legacy `main` fallback) is implemented directly, since enumerating a
package's available entry points isn't something `import.meta.resolve`
does — it resolves one already-known specifier.

Each resolved module is parsed with acorn (`ecmaVersion: 'latest'`,
`sourceType: 'module'`) — a real parser, not a regex, so template literals,
comments and strings containing the word `await` don't produce false
positives. A module format check (`.mjs`/`.cjs` override, else the nearest
controlling `package.json`'s `"type"`, found via `module.findPackageJSON`)
determines whether to keep walking: a CommonJS file reached via `import` is a
hard boundary — confirmed empirically that `require()` succeeds through one
regardless of what's inside it, since CJS syntax cannot contain top-level
await in the first place.

A `.js` file with no `"type"` field anywhere above it (no controlling
`package.json`, or one that doesn't set `"type"`) is not actually ambiguous to
Node: its own module-syntax detection (on by default since Node 22.7,
`--no-experimental-detect-module` to disable) tries to parse the file as
CommonJS, and loads it as an ES module instead if that fails because the
parser hit `import`/`export`/`import.meta`/top-level `await`. A file whose
*only* ESM-looking construct is a bare top-level `await` — no `import` or
`export` anywhere — still gets loaded as an ES module this way, several hops
into a dependency with no `"type"` field of its own. Getting this wrong (i.e.
assuming "no `type` field" means CommonJS) is a false negative: exactly the
case this tool exists to catch. It's reproduced here as two acorn parses —
`sourceType: 'script'` first (this is what actually fails on `import`/`export`
statements, and on `await x` for the same reason V8's synchronous, non-async
CommonJS wrapper does: `await` is just an identifier outside an async
function, so `await x` parses as two adjacent expressions with no operator
between them), then `sourceType: 'module'` if that fails. `"type": "commonjs"`
set explicitly disables this detection entirely, same as in real Node.

Static `import` and `export ... from` declarations count as graph edges.
Dynamic `import()` does not — confirmed empirically that a module calling
`import()` on a top-level-await module, without an `await` of its own at the
top level, still `require()`s successfully, since dynamic import doesn't
block synchronous linking.

The worker that does the walk runs in a separate child `node` process (one
per `checkPackage` call) so `--conditions` and
`--experimental-import-meta-resolve` can be set for it independently of the
calling process. It never imports or evaluates the target package's code —
only `import.meta.resolve`, `fs.readFileSync`, and parsing.

## Limitations

- TypeScript source is out of scope. Only files Node itself would load at
  `require()` time are analysed — `.ts` is not one of them.
- `.wasm` and `.node` (native addon) files are dead ends, not analysed
  further: reported as `unsupported` if they are the entry point, otherwise
  the walk just stops there and a note is attached. WebAssembly modules are
  gated behind `--experimental-wasm-modules` in real Node and weren't tested
  against that flag.
- The legacy `main` fallback (no `exports` map) implements the common
  extension/`index.js` search, not every historical edge case of Node's CJS
  file resolution algorithm.
- The ambiguous-`.js` sniff (see "How it works") reproduces every documented
  trigger for Node's own module-syntax detection except one: lexically
  redeclaring `require`, `module`, `exports`, `__dirname` or `__filename` at
  the top level. That's syntactically valid either way — it only collides
  with the real CommonJS wrapper's parameters at evaluation time — so it is
  not detected, and a file whose only ESM "tell" is that specific pattern is
  misclassified as CommonJS.
- If a file parses as neither valid CommonJS nor a valid ES module (a genuine
  syntax error), that entry is reported `unresolved` rather than guessed
  either way.
- A dependency that can't be resolved makes that entry `unresolved`, not a
  verdict. This tool does not guess past a missing or unreadable file.
- It does not execute or evaluate the target package. A `require()` that
  fails for a reason unrelated to top-level await — a syntax error, a missing
  native binding, code that throws on load — is not something this tool can
  see; it only walks static `import`/`export from` edges and parses each file.
- It reports every top-level await reachable from an entry, not just the
  first one Node's real `require()` would hit — useful for fixing all of them
  at once, but the `awaits` array is not the literal single-error output
  `require()` would produce.

## Compatibility

Actually run: Node 24.20.0 (macOS). `engines` declares `>=20.6.0` because
`import.meta.resolve` with a `parent` argument, used throughout, needs at
least that version — not independently verified on 20.x or 22.x.

## Development

```sh
npm install
npx tsc --noEmit
node --test "test/*.test.ts"      # 38 tests over 23 fixtures: 25 cases cross-
                                   # checked against a real `require()` in a
                                   # child process, plus 13 behavioural
                                   # assertions (chains, dynamic import, CJS
                                   # boundaries, export conditions, patterns,
                                   # ambiguous no-"type" detection, unresolved
                                   # dependencies)
npm run build && npm run test:dist
```

### Real-world check

Installed 24 popular npm packages (`chalk`, `execa`, `got`, `ky`, `nanoid`,
`node-fetch`, `p-limit`, `p-queue`, `globby`, `boxen`, `ora`, `listr2`, and
more) plus `temp-dir@3.0.0` — the actual package from the `lru-cache`/`prettier`
issues above, as a positive control — into a scratch project, and ran
`tla-check --installed` against it. It reported 26 entry points across 23 of
the 25 packages as `ok` (several packages, like `nanoid` and `listr2`, export
more than one subpath); `temp-dir` as `top-level-await`; and `del-cli`, which
has no `main`/`exports` at all — it's a CLI-only tool — as `unresolved` rather
than `ok`.

Cross-checked every verdict against a real `require()` in a separate Node
process: 27/27 of the `ok`/`top-level-await` verdicts agreed, and the real
`require('del-cli')` also failed, with `MODULE_NOT_FOUND` — matching
`unresolved`, not contradicting it. None of the 24 general-purpose packages
has a top-level await in its default entry's graph — most of the incidents
above have since been patched upstream — which is why `temp-dir` was added
deliberately: a real-world run with zero positives either means there's
nothing left to find, or that something is being missed, and those look the
same from the outside. `tla-check` on `temp-dir` reproduces the finding, with
the exact source line from the issue reports:

```
$ npx tla-check node_modules/temp-dir
temp-dir@3.0.0
  . ((direct target)): FAILS require() — top-level await found
    at file:///.../node_modules/temp-dir/index.js:4:27
      const temporaryDirectory = await fs.realpath(os.tmpdir());
```

## License

MIT
