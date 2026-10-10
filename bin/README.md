# bin/

Executable entry points published through the `bin` field of the root `package.json`.

| File      | Command | Purpose                                                                 |
| --------- | ------- | ----------------------------------------------------------------------- |
| `ccam.js` | `ccam`  | Thin launcher for the Claude Code Agent Monitor CLI implemented in [`../cli/`](../cli/README.md). |

## How `ccam` gets on your PATH

`npm run setup` ends with `npm run link-cli`, which runs `npm link` and creates a global `ccam` symlink pointing at `bin/ccam.js`. If linking fails (usually a permissions issue), link it yourself:

```bash
npm link
ccam --version
```

Without linking, run it directly from the checkout:

```bash
node bin/ccam.js help
```

## Why the launcher is so small

`ccam.js` resolves the **real** path of itself (`fs.realpathSync(__filename)`) before loading `../cli/index.js`. The global symlink created by `npm link` lives outside the repo, so resolving through it is what lets the CLI still find the checkout's `cli/`, `node_modules/`, and `data/` directories.

Keep this file a thin shim — all command logic, options, and output belong in `cli/`.

## Related

- [`cli/README.md`](../cli/README.md) — CLI internals and how to add a command
- [`docs/CLI.md`](../docs/CLI.md) — full user-facing command reference
