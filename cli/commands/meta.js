/**
 * @file ccam meta commands: help (any command path), version, commands (the
 * full command tree — human tree view, or a machine-readable JSON schema of
 * every command, argument, and option for agents), completion (bash / zsh /
 * fish scripts driven by the hidden Cobra-style `__complete` protocol), and
 * repl (the interactive shell).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const path = require("node:path");
const { Argument } = require("commander");
const { c, printJson } = require("../lib/ui");
const { isJson, pkgVersion } = require("../lib/runtime");
const {
  run,
  resolveCommand,
  describeCommand,
  visibleSubcommands,
  completeWords,
} = require("../lib/framework");

const GROUP = "CLI:";

/** `ccam help [command…]` — help for any command path, on stdout, exit 0. */
function cmdHelp(program, words) {
  const { cmd, consumed } = resolveCommand(program, words);
  if (consumed.length < words.length) {
    const parent = cmd;
    parent.args = [words[consumed.length]];
    parent.unknownCommand();
  }
  cmd.outputHelp();
}

/** Human command tree: every command with aliases and description, grouped. */
function renderCommandTree(program) {
  const width = 36;
  const walk = (cmds, prefix) => {
    cmds.forEach((s, i) => {
      const last = i === cmds.length - 1;
      const args = s.registeredArguments
        .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
        .join(" ");
      const alias = s.aliases().length ? ` (${s.aliases().join(", ")})` : "";
      const branch = `${prefix}${last ? "└─ " : "├─ "}`;
      const plain = `${branch}${s.name()}${args ? ` ${args}` : ""}${alias}`;
      const pad = " ".repeat(Math.max(2, width - plain.length));
      console.log(
        `${c.dim(branch)}${c.cyan(s.name())}${args ? ` ${c.dim(args)}` : ""}${c.dim(alias)}${pad}${c.dim(s.description())}`
      );
      walk(visibleSubcommands(s), prefix + (last ? "   " : "│  "));
    });
  };
  const groups = new Map();
  for (const s of visibleSubcommands(program)) {
    const g = (s.helpGroup() || "Commands:").replace(/:$/, "");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  for (const [g, cmds] of groups) {
    console.log(`\n${c.cyan("▍")}${c.bold(g)}`);
    walk(cmds, "  ");
  }
}

/** Shell completion scripts; each calls back into `ccam __complete <words…>`. */
const COMPLETION = {
  bash: `# ccam bash completion
# Load now:        source <(ccam completion bash)
# Load always:     ccam completion bash >> ~/.bashrc
_ccam_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(ccam __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null) )
}
complete -o default -F _ccam_complete ccam
`,
  zsh: `#compdef ccam
# ccam zsh completion
# Load now:        source <(ccam completion zsh)      (after compinit)
# Load always:     ccam completion zsh > "\${fpath[1]}/_ccam"
_ccam() {
  local -a candidates
  candidates=("\${(@f)$(ccam __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  compadd -a candidates
}
if [ "$funcstack[1]" = "_ccam" ]; then _ccam "$@"; else compdef _ccam ccam; fi
`,
  fish: `# ccam fish completion
# Load now:        ccam completion fish | source
# Load always:     ccam completion fish > ~/.config/fish/completions/ccam.fish
complete -c ccam -f -a '(ccam __complete (commandline -opc)[2..-1] (commandline -ct))'
`,
};

function detectShell() {
  const sh = path.basename(process.env.SHELL || "");
  return COMPLETION[sh] ? sh : "bash";
}

/** Entry for the hidden completion protocol (called before Commander parses). */
function completeAndPrint(program, words) {
  for (const cand of completeWords(program, words)) process.stdout.write(`${cand}\n`);
}

function register(program) {
  program
    .command("help")
    .helpGroup(GROUP)
    .description("Show help for any command (e.g. ccam help alerts ack)")
    .argument("[command...]", "command path")
    .action((words) => cmdHelp(program, words || []));

  program
    .command("version")
    .helpGroup(GROUP)
    .description("Print the ccam version (also --version, -v)")
    .action(
      run(() => {
        const v = pkgVersion();
        if (isJson()) return printJson({ name: "ccam", version: v });
        console.log(v ? `ccam ${v}` : "ccam (version unknown)");
      })
    );

  program
    .command("commands")
    .helpGroup(GROUP)
    .description("Every command as a tree (--json: machine-readable schema for agents)")
    .action(
      run(() => {
        if (isJson()) return printJson({ version: pkgVersion(), ...describeCommand(program) });
        console.log(
          `${c.cyan("▍")}${c.bold("ccam command tree")} ${c.dim("— ccam <command> --help for details")}`
        );
        renderCommandTree(program);
      })
    );

  program
    .command("completion")
    .helpGroup(GROUP)
    .description("Print a shell completion script (bash, zsh, or fish)")
    .addArgument(
      new Argument("[shell]", "target shell (default: $SHELL)").choices(Object.keys(COMPLETION))
    )
    .action(
      run(({ args }) => {
        process.stdout.write(COMPLETION[args[0] || detectShell()]);
      })
    );

  program
    .command("repl")
    .alias("shell")
    .alias("i")
    .helpGroup("Server:")
    .description("Interactive shell: completion, history, live status prompt, watch")
    .action(run(() => require("../repl").startRepl(program)));
}

module.exports = { register, completeAndPrint };
