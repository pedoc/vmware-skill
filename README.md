# vmware-skill

Control VMware Workstation Pro virtual machines from Claude Code — **no MCP server, no daemon**.

Wraps VMware's own `vmrun.exe` / `vmcli.exe` / `vmrest.exe` behind a single zero-dependency
Node script. Commands run and exit; nothing stays resident.

> Built by reading the source of [`ZacharyZcR/vmware-mcp`](https://github.com/ZacharyZcR/vmware-mcp)
> and cross-checking every command against a live VMware Workstation Pro 26.0.1 install.
> See [Relationship to vmware-mcp](#relationship-to-vmware-mcp) below.

## Install

### Claude Code (recommended)

```bash
/plugin marketplace add pedoc/vmware-skill
/plugin install vmware@pedoc-skills
```

### Any agent that supports the open skills standard

```bash
npx skills add pedoc/vmware-skill
```

Add `-g` to install globally (user-level) rather than into the current project.

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
| `guest` | in-guest `ls` `mkdir` `rm` `mv` `copy-to` `copy-from` `run` `script` `ps` `kill` `exists` `env` |
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

## REST API (optional)

The CLIs can't add a NIC, create a virtual network, clone a VM, or change CPU/memory — those
need the REST API. It's optional; everything else works without it.

```sh
"C:/Program Files/VMware/VMware Workstation/vmrest.exe" -C    # one-time credential setup
"C:/Program Files/VMware/VMware Workstation/vmrest.exe"       # run the service

export VMWARE_USERNAME=...
export VMWARE_PASSWORD=...
node scripts/vmware.js rest status
```

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
