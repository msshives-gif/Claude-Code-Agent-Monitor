/**
 * @file The ccam command framework, layered on Commander.js (the Node
 * analogue of Go's Cobra). It adds the conventions every ccam command shares:
 *
 * - CcamCommand: a Command subclass whose errors (unknown command/option,
 *   missing argument, invalid value) render in ccam's style with the exact
 *   usage line and a --help pointer — or as JSON in --json mode — and never
 *   call process.exit directly (the program's exitOverride turns them into
 *   exceptions the entry point converts to an exit code).
 * - run(): the action wrapper. It hands handlers a `ctx` ({ args, opts, cmd })
 *   with global options merged in, and routes ServerDownError to the
 *   command's offline fallback or to the standard server-required refusal.
 * - listGroup(): a resource group (e.g. `alerts`) whose bare invocation lists
 *   the resource, with an explicit `list|ls` subcommand sharing the options.
 * - confirm(): the write-confirmation gate (--yes, or an interactive y/N on a
 *   TTY; non-interactive shells must pass --yes).
 * - Option parsers, JSON body input (--data JSON|@file|-, --file path).
 * - Introspection: completeWords() powers REPL tab-completion and the
 *   Cobra-style hidden `__complete` command behind bash/zsh/fish completion
 *   scripts; describeCommand() emits the machine-readable command tree.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Command, InvalidArgumentError } = require("commander");
const { c } = require("./ui");
const { isJson, CliError, ServerDownError, reportError } = require("./runtime");
const { offlineBanner, serverDown } = require("./offline");

/** Map Commander's internal error codes to stable, documented ccam codes. */
const COMMANDER_CODES = {
  "commander.unknownCommand": "UNKNOWN_COMMAND",
  "commander.unknownOption": "UNKNOWN_OPTION",
  "commander.missingArgument": "MISSING_ARGUMENT",
  "commander.optionMissingArgument": "MISSING_OPTION_VALUE",
  "commander.missingMandatoryOptionValue": "MISSING_REQUIRED_OPTION",
  "commander.invalidArgument": "INVALID_ARGUMENT",
  "commander.excessArguments": "TOO_MANY_ARGUMENTS",
  "commander.conflictingOption": "CONFLICTING_OPTIONS",
};

/** Small Damerau-free Levenshtein for "did you mean" suggestions. */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function suggest(word, candidates) {
  const scored = candidates
    .map((cand) => ({ cand, d: editDistance(word, cand) }))
    .filter(({ cand, d }) => d <= Math.max(1, Math.floor(cand.length / 3)) || cand.startsWith(word))
    .sort((x, y) => x.d - y.d);
  return [...new Set(scored.map((s) => s.cand))].slice(0, 3);
}

/** Visible (non-hidden) subcommands of a command. */
const visibleSubcommands = (cmd) => cmd.commands.filter((s) => !s._hidden);

class CcamCommand extends Command {
  createCommand(name) {
    return new CcamCommand(name);
  }

  /** Inherit output/help/exit settings, but not two per-command choices:
   *  excess-argument tolerance (a group that accepts stray operands must not
   *  leak that to its subcommands) and Commander's implicit `help`
   *  subcommand (`ccam help <path…>` / `--help` cover it everywhere). */
  copyInheritedSettings(source) {
    super.copyInheritedSettings(source);
    this._allowExcessArguments = false;
    this._addImplicitHelpCommand = false;
    return this;
  }

  /** Full invocation path, e.g. "ccam alerts ack". */
  commandPath() {
    const names = [];
    for (let cmd = this; cmd; cmd = cmd.parent) names.unshift(cmd.name());
    return names.join(" ");
  }

  /** Render every framework error in ccam's style (or JSON) with usage hints. */
  error(message, errorOptions = {}) {
    let msg = String(message);
    // Commander's own messages start "error: …" — restyle those as sentences.
    if (/^error:\s*/i.test(msg)) {
      msg = msg.replace(/^error:\s*/i, "");
      msg = msg.charAt(0).toUpperCase() + msg.slice(1);
    }
    const hints = [...(errorOptions.hints || [])];
    hints.push(`Usage: ${this.commandPath()} ${this.usage()}`);
    hints.push(`Run "${this.commandPath()} --help" for details.`);
    reportError(
      new CliError(msg, {
        hints,
        code: COMMANDER_CODES[errorOptions.code] || "USAGE",
      })
    );
    this._exit(errorOptions.exitCode ?? 1, errorOptions.code || "ccam.usage", msg);
  }

  missingArgument(name) {
    const arg = this.registeredArguments.find((a) => a.name() === name);
    const what = arg?.description || `<${name}> argument`;
    const article = /^[aeiou]/i.test(what) ? "an" : "a";
    this.error(`${this.name()} requires ${article} ${what}`, { code: "commander.missingArgument" });
  }

  unknownCommand() {
    const name = this.args[0];
    const names = visibleSubcommands(this).flatMap((s) => [s.name(), ...s.aliases()]);
    const matches = suggest(name, names);
    const where = this.parent ? ` (for "${this.commandPath()}")` : "";
    this.error(`Unknown command: ${name}${where}`, {
      code: "commander.unknownCommand",
      hints: matches.length ? [`Did you mean: ${matches.join(", ")}?`] : [],
    });
  }
}

/**
 * Wrap a handler as a Commander action. The handler receives
 * `{ args, opts, cmd }` — declared positional arguments in order, the merged
 * local + global options, and the Command itself.
 *
 * `offline(ctx)` runs (under the offline banner) when the server is down;
 * otherwise `serverOnly` is the reason printed in the server-required refusal.
 */
function run(handler, { offline, serverOnly } = {}) {
  return async function action(...raw) {
    const cmd = raw[raw.length - 1];
    const ctx = { args: raw.slice(0, -2), opts: cmd.optsWithGlobals(), cmd };
    try {
      await handler(ctx);
    } catch (err) {
      if (!(err instanceof ServerDownError)) throw err;
      if (!offline) {
        serverDown(serverOnly);
        return;
      }
      offlineBanner();
      try {
        await offline(ctx);
      } catch (offErr) {
        if (offErr instanceof CliError) throw offErr;
        throw new CliError(`Offline read failed: ${offErr?.message || offErr}`, {
          code: "OFFLINE_READ_FAILED",
        });
      }
    }
  };
}

/**
 * Define a resource group whose bare invocation lists the resource:
 * `ccam alerts` ≡ `ccam alerts list` ≡ `ccam alerts ls`. `configure(cmd)`
 * applies the list options to both the group and its `list` subcommand so
 * `ccam alerts --unacked` keeps working. A non-subcommand operand is reported
 * as an unknown command with the group's usage.
 */
function listGroup(parent, name, spec) {
  const {
    description,
    group,
    aliases = [],
    configure = () => {},
    handler,
    offline,
    serverOnly,
    listDescription,
  } = spec;
  const g = parent.command(name).description(description);
  for (const a of aliases) g.alias(a);
  if (group) g.helpGroup(group);
  configure(g);
  g.allowExcessArguments();
  const wrapped = run(handler, { offline, serverOnly });
  g.action(async (...raw) => {
    const cmd = raw[raw.length - 1];
    if (cmd.args.length) cmd.unknownCommand();
    return wrapped(...raw);
  });
  const l = g
    .command("list")
    .alias("ls")
    .description(listDescription || `List ${name} (default)`);
  configure(l);
  l.action(wrapped);
  return g;
}

/**
 * Write-confirmation gate. Passes with --yes; on an interactive terminal it
 * asks y/N; otherwise it refuses with `refusal` (e.g. "Webhook writes require
 * --yes.") so scripts and agents must opt in explicitly.
 */
async function confirm(opts, { prompt, refusal }) {
  if (opts.yes) return;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isJson();
  if (!interactive) {
    throw new CliError(refusal, {
      code: "CONFIRMATION_REQUIRED",
      hints: ["Re-run with --yes to confirm (non-interactive shells cannot prompt)."],
    });
  }
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question(`${c.yellow("?")} ${prompt} ${c.dim("[y/N]")} `, resolve)
  );
  rl.close();
  if (!/^y(es)?$/i.test(String(answer).trim())) {
    throw new CliError("Aborted — nothing was changed.", { code: "ABORTED" });
  }
}

// ── Option parsers ──────────────────────────────────────────────────────────

/** Non-negative integer option parser. */
function intArg(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("Must be a whole number ≥ 0.");
  return n;
}

/** Positive integer option parser. */
function posIntArg(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("Must be a whole number ≥ 1.");
  return n;
}

/** Non-negative finite number (rates, thresholds). */
function numArg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("Must be a number ≥ 0.");
  return n;
}

/** Comma-separated list; repeatable (`--type A,B --type C`). */
function csvArg(v, prev) {
  const items = String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...(prev || []), ...items];
}

/** Repeatable `key=value` pairs into an object. */
function kvArg(v, prev) {
  const i = String(v).indexOf("=");
  if (i <= 0) throw new InvalidArgumentError("Expected key=value.");
  return { ...(prev || {}), [String(v).slice(0, i).trim()]: String(v).slice(i + 1) };
}

/** Lenient boolean parser: true/false, yes/no, on/off, 1/0. */
function boolArg(v) {
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new InvalidArgumentError("Expected true/false.");
}

/**
 * Read a JSON request body from `--<key> JSON` (also `@file` and `-` for
 * stdin) or `--file path`. Returns undefined when neither is given.
 */
function readJsonInput(opts, key = "data") {
  let raw;
  let where;
  if (opts.file) {
    const target = path.resolve(process.cwd(), String(opts.file));
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (err) {
      throw new CliError(`Cannot read --file ${target}: ${err.message}`, { code: "BAD_INPUT" });
    }
    where = `--file ${opts.file}`;
  } else {
    const v = opts[key];
    if (v == null || v === true) return undefined;
    const s = String(v);
    if (s === "-") {
      raw = fs.readFileSync(0, "utf8");
      where = `--${key} - (stdin)`;
    } else if (s.startsWith("@")) {
      const target = path.resolve(process.cwd(), s.slice(1));
      try {
        raw = fs.readFileSync(target, "utf8");
      } catch (err) {
        throw new CliError(`Cannot read ${target}: ${err.message}`, { code: "BAD_INPUT" });
      }
      where = `--${key} ${s}`;
    } else {
      raw = s;
      where = `--${key}`;
    }
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`Invalid JSON in ${where}: ${err.message}`, { code: "BAD_INPUT" });
  }
}

/** Standard --data/--file/--yes trio for raw-JSON write commands. */
function jsonBodyOptions(cmd, what = "request body") {
  return cmd
    .option("--data <json>", `${what} as JSON (or @file, or - for stdin)`)
    .option("--file <path>", `read the ${what} JSON from a file`);
}

// ── Introspection: completion + command tree ───────────────────────────────

/** The root command (global options live there). */
function rootOf(cmd) {
  let root = cmd;
  while (root.parent) root = root.parent;
  return root;
}

/** Options that apply at a command: its own plus the root's globals. A
 *  group's list flags (e.g. `alerts --unacked`) do not apply to siblings. */
function applicableOptions(cmd) {
  const root = rootOf(cmd);
  return cmd === root ? root.options : [...cmd.options, ...root.options];
}

/** Find an option (by flag) applicable at a command. */
function findOption(cmd, flag) {
  const bare = flag.split("=")[0];
  return applicableOptions(cmd).find((o) => o.long === bare || o.short === bare) || null;
}

/** All option flags visible at a command (its own + global options). */
function optionFlags(cmd) {
  const flags = new Set(["--help"]);
  for (const o of applicableOptions(cmd)) if (!o.hidden && o.long) flags.add(o.long);
  return [...flags];
}

/** Resolve a word path (["alerts", "ack"]) to the deepest matching command. */
function resolveCommand(program, words) {
  let cmd = program;
  const consumed = [];
  for (const w of words) {
    const sub = cmd.commands.find((s) => s.name() === w || s.aliases().includes(w));
    if (!sub) break;
    cmd = sub;
    consumed.push(w);
  }
  return { cmd, consumed };
}

/**
 * Completion candidates for a partial command line. `words` are the tokens
 * after `ccam`; the last one is the word being completed ("" for a fresh
 * word). Subcommands complete at every depth, options once `-` is typed
 * (including inherited global options), and option/argument values from
 * their declared choices.
 */
function completeWords(program, words) {
  const done = words.slice(0, -1);
  const partial = words.length ? words[words.length - 1] : "";
  let cmd = program;
  let pendingValue = null;
  let positionals = 0;
  for (const w of done) {
    if (pendingValue) {
      pendingValue = null;
      continue;
    }
    if (w.startsWith("-")) {
      const opt = findOption(cmd, w);
      if (opt && opt.required && !w.includes("=")) pendingValue = opt;
      continue;
    }
    const sub = cmd.commands.find((s) => s.name() === w || s.aliases().includes(w));
    if (sub && positionals === 0) cmd = sub;
    else positionals++;
  }
  const pick = (list) => list.filter((x) => String(x).startsWith(partial));
  if (pendingValue) return pick(pendingValue.argChoices || []);
  if (partial.startsWith("-")) return pick(optionFlags(cmd));
  if (positionals === 0) {
    const subs = visibleSubcommands(cmd).map((s) => s.name());
    if (subs.length) return pick(subs);
  }
  const arg = cmd.registeredArguments[Math.min(positionals, cmd.registeredArguments.length - 1)];
  return pick(arg?.argChoices || []);
}

/** Machine-readable description of a command subtree (for `commands --json`). */
function describeCommand(cmd) {
  return {
    name: cmd.name(),
    path: cmd.commandPath ? cmd.commandPath() : cmd.name(),
    aliases: cmd.aliases(),
    group: cmd.helpGroup() || null,
    description: cmd.description(),
    usage: cmd.usage(),
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
      description: a.description || null,
      choices: a.argChoices || null,
    })),
    options: cmd.options
      .filter((o) => !o.hidden)
      .map((o) => ({
        flags: o.flags,
        name: o.attributeName(),
        description: o.description,
        takes_value: Boolean(o.required || o.optional),
        choices: o.argChoices || null,
        default: o.defaultValue === undefined ? null : o.defaultValue,
      })),
    commands: visibleSubcommands(cmd).map(describeCommand),
  };
}

module.exports = {
  CcamCommand,
  run,
  listGroup,
  confirm,
  intArg,
  posIntArg,
  numArg,
  csvArg,
  kvArg,
  boolArg,
  readJsonInput,
  jsonBodyOptions,
  completeWords,
  resolveCommand,
  describeCommand,
  visibleSubcommands,
  suggest,
};
