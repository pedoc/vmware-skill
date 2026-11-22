# vmware-skill

Control VMware Workstation Pro virtual machines from Claude Code — **no MCP server, no daemon**.

Wraps VMware's own `vmrun.exe` / `vmcli.exe` / `vmrest.exe` behind a single zero-dependency
Node script. Commands run and exit; nothing stays resident.

> Built by reading the source of [`ZacharyZcR/vmware-mcp`](https://github.com/ZacharyZcR/vmware-mcp)
> and cross-checking every command against a live VMware Workstation Pro 26.0.1 install.
> See [Relationship to vmware-mcp](#relationship-to-vmware-mcp) below.

## Install

```bash
npx skills add pedoc/vmware-skill
```

Add `-g` to install globally (user-level) rather than into the current project.
The skill lands in `~/.agents/skills/vmware/`, symlinked into each detected agent's
skill directory — Claude Code included.

To update it later:

```bash
npx skills update vmware -g
```

### CLI only (for scripting)

Run straight from GitHub — no npm publish required:

```bash
npx --allow-git=all github:pedoc/vmware-skill vm list --power
```

> `--allow-git=all` is needed because recent npm versions default `allow-git` to `none`
> (a supply-chain hardening change). `npx github:...` is refused without it.

Or clone and run directly:

```bash
git clone https://github.com/pedoc/vmware-skill.git
node vmware-skill/skills/vmware/scripts/vmware.js vm list --power
```

## Requirements

- **VMware Workstation Pro 17+** (verified on 26.0.1)
- **Node.js 18+**
- `vmrun.exe` / `vmcli.exe` — auto-detected in the standard install paths, or set
  `VMRUN_PATH` / `VMCLI_PATH`
- `vmrest.exe` — only for the few operations the CLIs can't do (see below)

## Usage

```sh
node skills/vmware/scripts/vmware.js vm list --power
node skills/vmware/scripts/vmware.js power status "Ubuntu 22 x64"
node skills/vmware/scripts/vmware.js snapshot take "Win10" "before-upgrade"
node skills/vmware/scripts/vmware.js help <group>
```

Virtual machines are referenced **by name or by `.vmx` path** — both work:

```sh
node scripts/vmware.js power status "Win10"
node scripts/vmware.js power status "K:/VirtualMachines/Win10/Windows 10 x64.vmx"
```

Name resolution reads VMware's own `inventory.vmls`, so **vmrest does not need to be running**.

## Command groups

| Group | Does |
|---|---|
| `vm` | `list` / `info` (full config dump) / `running` |
| `power` | `status` `start` `stop` `reset` `suspend` `pause` `unpause` |
| `snapshot` | `list` `take` `revert` `delete` `clone` — **by name**, uid auto-resolved |
| `guest` | in-guest `ls` `mkdir` `rm` `mv` `copy-to` `copy-from` `put-dir` `get-dir` `exec` `run` `script` `ps` `kill` `exists` `dir-exists` `ready` `env` |
| `shared` | shared folders `list` `add` `remove` `set` `enable` `disable` |
| `chipset` | `query` `cpu` `memory` `cores` |
| `config` | read/write `.vmx` config params |
| `disk` | `list` `create` `extend` |
| `nic` | `list` `set-type` `set-present` `set-device` `set-network` `purge` `add` |
| `net` | host networks `list`, port forwarding `list`/`set`/`delete` |
| `tools` | `status` `install` `upgrade` |
| `screen` | `capture` (screenshot — **no guest password needed**) / `keys` |
| `device` | `connect` `disconnect` named devices |
| `vars` | `read` `write` VM variables |
| `template` | `create` `deploy` |
| `clone` / `vmnew` | clone / create VMs |
| `rest` | raw REST API access |
| `raw` | escape hatch: `raw vmcli ...` / `raw vmrun ...` |

## Guest credentials

Operations inside the guest OS need the **guest's** login, passed via environment variables
(not argv — argv lands in the process list and shell history):

```sh
export VMWARE_GUEST_USER=root
export VMWARE_GUEST_PASS='...'
node scripts/vmware.js guest ps "Ubuntu 22 x64"
```

Requires VMware Tools installed and running in the guest.

**Exception:** `screen capture` uses `vmcli MKS`, which needs no credentials.

Passwords are masked as `***` in every command line this script prints, so a timeout or error
message never leaks them into logs or transcripts.

## Running work inside the guest

**`guest exec` is the one you want** — it brings back stdout+stderr and propagates the guest's
exit code:

```sh
node scripts/vmware.js guest exec "Win10" "dir C:\\Windows"
node scripts/vmware.js guest exec "Ubuntu 22 x64" "systemctl is-active nginx"   # exit code passes through
```

The command is uploaded as a small script file and run from there, so `>`, `|`, `&&` and quoting
all behave normally — nothing rewrites your command line.

`guest run` is a thin `vmrun` passthrough that **does not capture output**; use it only for
interactive programs or ones that log to a file themselves.

`guest script <vm> <interpreter> <body>` uploads the body as a temp file and executes it,
deliberately **not** via `runScriptInGuest` — that call hangs forever against a Windows guest
(verified: `runScriptInGuest <vmx> cmd.exe "echo hi"` never returns; the `cmd.exe /c` form
reports `A file was not found`). On Windows the interpreter argument is ignored and the body
runs as a `.bat` through `cmd.exe /c`. It does not return the script's output either — use
`guest exec` for that.

`guest exists` / `guest dir-exists` are queries, not assertions: an absent path prints `false`
and exits 0.

`guest ready` waits until guest operations actually work. Check `ready: true` rather than
`tools status` — a wedged guest channel still reports `running`, and only a real round trip
tells you it's usable:

```sh
node scripts/vmware.js guest ready "Win10" --timeout 300
```

## Git Bash / MSYS2 on Windows

Claude Code on Windows runs commands through Git Bash, which rewrites `/c`, `/tmp` and friends
into `C:/...`. Set this first:

```sh
export MSYS_NO_PATHCONV=1
```

Without it, `guest exec vm "/c dir"` reaches the guest as `C:/ dir` and fails in a way that
looks like a timeout. Convert host paths handed to the guest with `cygpath -w`.

## Timeouts

Every command accepts `--timeout <seconds>` (default 120s; file transfers default to 1 hour).
`--timeout 0` disables the limit:

```sh
node scripts/vmware.js snapshot revert "Win10" "clean" --timeout 600
node scripts/vmware.js guest exec "Ubuntu 22 x64" "make -j4" --timeout 0
```

If a guest command genuinely needs the literal string `--timeout`, separate it with `--`.

## REST API (optional)

The CLIs can't add a NIC, create a virtual network, clone a VM, or change CPU/memory — those
need the REST API. It's optional; everything else works without it.

```sh
"C:/Program Files/VMware/VMware Workstation/vmrest.exe" -C    # one-time credential setup
"C:/Program Files/VMware/VMware Workstation/vmrest.exe"       # run the service

export VMWARE_REST_USER=...
export VMWARE_REST_PASSWORD=...
node scripts/vmware.js rest status
```

Two kinds of credentials, deliberately named apart:

| Variables | What they unlock |
|---|---|
| `VMWARE_GUEST_USER` / `VMWARE_GUEST_PASS` | login inside the guest OS (`guest` group) |
| `VMWARE_REST_USER` / `VMWARE_REST_PASSWORD` | vmrest HTTP basic auth (`rest` group) |
| `VMWARE_REST_HOST` / `VMWARE_REST_PORT` | vmrest address, default `127.0.0.1:8697` |

Generic names like `VMWARE_USERNAME` / `VMWARE_PASSWORD` are **not** read: they collide
with unrelated tooling and don't say whether they mean the guest or the REST API.

`vmrest -C` is interactive: it asks for a username and a new password twice. Password rules:
≥8 characters, at least one lowercase letter, one digit, and one special character from
``!#$%&'()*+,-./:;<=>?@[]^_`{|}~``.

## Gotchas baked into this skill

These were verified against a live install, not inferred from docs:

1. **`vmcli` arguments are mostly positional**, not `-flag value`. The upstream `vmware-mcp`
   project uses a flag style that doesn't exist:
   - `Ethernet SetPresent ethernet0 true` ✅ — `Ethernet SetPresent -i 0 -e true` ❌ (`Invalid/unrecognized argument "-e"`)
   - `Snapshot Take <name>` ✅ — `-n` is `--native`, not the name
   - `ConfigParams SetEntry <name> <value>` ✅ — not `-k`/`-v`
   - in `Guest`, `-p` is the **password**; the program path is positional
   - `Disk Create` needs `-f <file.vmdk>`; `-t` is an integer type (0–3), not `"scsi"`
2. **vmcli exits 0 on success, 127 on failure**; errors go to stderr.
3. **vmcli output is a YAML subset** — parsed to JSON here. Table output stays verbatim.
4. **Install paths differ by version** — `C:\Program Files\VMware\...` on modern releases,
   `C:\Program Files (x86)\VMware\...` on older ones. Both are auto-detected.
5. **`vmcli HGFS Set*` is buggy** — it treats the first positional argument as a boolean.
   Use `vmrun` (`addSharedFolder` / `removeSharedFolder` / `setSharedFolderState`) instead.
6. **Use forward slashes for `.vmx` paths** — Windows accepts both, but forward slashes avoid
   quoting problems.
7. **`vmcli Guest copyTo/copyFrom` caps out at 64KB.** Beyond that it reports `Unknown error`,
   or `VMware Tools are not running in the guest` — a false message, Tools is fine. Repeated
   failures also wedge the guest channel, after which *every* guest operation times out until
   the VM is rebooted. All file transfers here therefore go through `vmrun`, which handles
   arbitrary sizes (100 MB in ~28 s).
8. **`vmrun` re-quotes arguments containing spaces**, and `cmd.exe` then strips only one set of
   quotes — trailing up to a stray `"` in your command's output. `guest exec` avoids this by
   shipping the command as a script file instead of passing it inline.
9. **`runProgramInGuest -interactive` often fails on Windows guests**
   (`The specified guest user does not match the user currently logged in interactively`).
   Don't pass `--interactive` when Administrator is already logged in interactively.
10. **`chipset cpu|memory|cores` require a powered-off VM** — they go through the hot-plug path.
    To change what the *next* boot uses, write the `.vmx` instead: `config set <vm> memsize <MB>`.
11. **A wedged guest channel still reports `tools status: running`.** Use `guest ready`; if it
    never goes true, `power stop --hard` and start again.
12. **Value-taking flags need `--flag value`, which the parser now honours.** Boolean flags are
    listed in `VALUE_FLAGS`; `--memory` is boolean for `snapshot take` and numeric for
    `rest vm-update`.
13. **`Ethernet SetPresent` silently does nothing when the label isn't already in the `.vmx`**,
    and still exits 0. `nic set-present` / `set-connected` write the config entry instead.
14. **`vmcli Disk Create` only writes the `.vmdk`; it does not attach it.** Without a
    `sataN:M.fileName` entry and a controller the VM's `disks` array stays empty. `disk create`
    now attaches automatically; pass `--no-attach` for a bare file.
15. **VMs created by `vmnew` / `snapshot clone` are not registered in `inventory.vmls`**, so
    they can't be addressed by name until Workstation has opened them once. Use the `.vmx` path.
16. **`snapshot clone` and `clone` need the destination directory to exist**, otherwise
    `Could not find the file`.
17. **`template deploy` accepts only `-p <template.vmtx>`** — there is no destination or name
    option; the VM lands beside the template and inherits its name.
18. **`net portforward-set/delete` can fail with `Failed to refresh NAT configuration`** even
    though `vmnetnat.conf` was updated correctly. Plain `vmrun` fails the same way; restart
    `VMware NAT Service` to clear it.

## Relationship to vmware-mcp

[`ZacharyZcR/vmware-mcp`](https://github.com/ZacharyZcR/vmware-mcp) exposes the same
capability surface as an MCP server with 117 tools. This project takes the same capability set
and expresses it as a skill plus a single script, because:

- **No daemon, no protocol layer.** The capability is "invoke these CLIs" — an MCP server adds
  a process, a transport, and a failure surface for no gain.
- **The upstream vmcli layer doesn't work.** Its `vmcli.py` invents flag syntax that the real
  `vmcli.exe` rejects. Every command here was checked against `vmcli --help` on a live install.
- **The upstream tool needs the REST API up just to resolve a VM name** to a `.vmx` path.
  Here, name resolution reads VMware's own `inventory.vmls`, so the CLIs work standalone.
- **Hardcoded `(x86)` paths** in the upstream project break on current releases.

## Development

```bash
git clone https://github.com/pedoc/vmware-skill.git
cd vmware-skill
npm test          # syntax check + smoke test
```

CI runs on every push: syntax check, manifest validation, and a smoke test.

## License

MIT
