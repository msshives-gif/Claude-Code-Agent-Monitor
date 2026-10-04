#!/usr/bin/env node

/**
 * @file ccam — the Claude Code Agent Monitor command-line interface.
 *
 * Thin executable entry point. The CLI itself lives in ../cli/: a
 * Commander.js command tree (cli/index.js) with shared conventions in
 * cli/lib/framework.js, command modules in cli/commands/, and the
 * interactive shell in cli/repl.js. After `npm run setup` (which links this
 * binary via `npm link`) every command is available as `ccam <command>`;
 * `ccam help` lists them and `ccam commands --json` describes them for
 * machines.
 *
 * Resolved through the REAL path of this file so the global symlink `npm
 * link` creates still finds the checkout's cli/ and node_modules/.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(path.dirname(fs.realpathSync(__filename)), "..");
require(path.join(root, "cli", "index.js")).main(process.argv);
