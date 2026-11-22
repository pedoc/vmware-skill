#!/usr/bin/env node
'use strict';
/**
 * vmware.js — zero-dependency wrapper over VMware Workstation's own CLIs.
 *
 *   vmrun.exe  : VM power / snapshot / guest file+process ops / clone / screen / host network
 *   vmcli.exe  : structured (YAML) device, chipset, disk, nic, hgfs, sata, nvme, serial config
 *   vmrest     : optional REST API (only for things the CLIs cannot do, e.g. adding a NIC)
 *
 * Usage:  node vmware.js <group> <command> [args...]
 *         node vmware.js help [group]
 *
 * Design notes:
 *  - No MCP server, no daemon required. vmrun/vmcli work standalone given a .vmx path.
 *  - VM names are resolved from VMware's own inventory (inventory.vmls), so the REST API
 *    is NOT needed to turn "Win10" into a .vmx path.
 *  - Guest credentials come from env vars only (VMWARE_GUEST_USER / VMWARE_GUEST_PASS),
 *    never from argv, so they do not leak into shell history or the process list.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ utils */

function fail(msg, code) {
  const e = new Error(msg);
  e.vmExit = code === undefined ? 1 : code;
  throw e;
}

function out(s) {
  process.stdout.write((s === undefined || s === null ? '' : String(s)) + '\n');
}

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e2) {
      return buf.toString('latin1');
    }
  }
}

function splitArgs(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      for (let j = i + 1; j < args.length; j++) pos.push(args[j]);
      break;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else flags[body] = true;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function bool(v) {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  return ['true', '1', 'yes', 'on'].indexOf(v.toLowerCase()) >= 0;
}

/* --------------------------------------------------------- tool discovery */

const VM_DIRS = [
  'C:\\Program Files\\VMware\\VMware Workstation',
  'C:\\Program Files (x86)\\VMware\\VMware Workstation',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/vmware/bin',
  '/Applications/VMware Fusion.app/Contents/Library',
];

function findTool(name) {
  const envKey = name.toUpperCase() + '_PATH';
  if (process.env[envKey]) return process.env[envKey];
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['', '.exe'];
  for (const dir of VM_DIRS) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch (e) { /* ignore */ }
    }
  }
  return null;
}

let _vmrun = undefined;
let _vmcli = undefined;
function vmrunPath() {
  if (_vmrun === undefined) {
    _vmrun = findTool('vmrun');
    if (!_vmrun) fail(
      'vmrun.exe not found. Set VMRUN_PATH, or install VMware Workstation 17+ ' +
      '(looked in: ' + VM_DIRS.join(', ') + ')'
    );
  }
  return _vmrun;
}
function vmcliPath() {
  if (_vmcli === undefined) {
    _vmcli = findTool('vmcli');
    if (!_vmcli) fail(
      'vmcli.exe not found. Set VMCLI_PATH, or install VMware Workstation 17+ ' +
      '(looked in: ' + VM_DIRS.join(', ') + ')'
    );
  }
  return _vmcli;
}

/* --------------------------------------------------------- process runner */

function run(exe, args, opts) {
  opts = opts || {};
  const res = spawnSync(exe, args, {
    windowsHide: true,
    timeout: opts.timeout || 120000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    env: process.env,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') fail('Executable not found: ' + exe);
    if (res.error.code === 'ETIMEDOUT') fail('Timed out after ' + (opts.timeout || 120000) + 'ms: ' + exe + ' ' + args.join(' '));
    fail('Failed to run ' + exe + ': ' + res.error.message);
  }
  return {
    code: res.status === null ? 1 : res.status,
    out: decodeText(res.stdout || Buffer.alloc(0)),
    err: decodeText(res.stderr || Buffer.alloc(0)),
  };
}

/** Run a CLI; on failure print stderr and exit with its code. */
function runOrDie(exe, args, opts) {
  const r = run(exe, args, opts);
  if (r.code !== 0) {
    const msg = (r.err || r.out || '').trim();
    process.stderr.write((msg || ('Command failed with exit code ' + r.code)) + '\n');
    process.exit(r.code);
  }
  return r.out.replace(/\s+$/, '');
}

function vmrun(args, opts) {
  return runOrDie(vmrunPath(), ['-T', 'ws'].concat(args), opts);
}

function vmcli(vmx, module, command, args, opts) {
  const a = [];
  if (vmx) a.push(vmx);
  a.push(module, command);
  if (args) a.push.apply(a, args);
  return runOrDie(vmcliPath(), a, opts);
}

/* ------------------------------------------------------- YAML-ish parsing */
/* vmcli emits a YAML subset: nested maps by indent, `- ` lists of scalars
   or maps, single-quoted strings. Enough to JSON-ify the common queries.    */

function yamlScalar(v) {
  v = String(v).trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true' || v === "'true'") return true;
  if (v === 'false' || v === "'false'") return false;
  if (v === "''" || v === '""') return '';
  // Flow style: [] {} [a, b] {k: v}
  if (v === '[]') return [];
  if (v === '{}') return {};
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => yamlScalar(s));
  }
  if (v.length >= 2 && ((v[0] === "'" && v[v.length - 1] === "'") || (v[0] === '"' && v[v.length - 1] === '"'))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function parseYaml(text) {
  const items = [];
  const prose = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const ind = line.match(/^ */)[0].length;
    const txt = line.trim();
    // A line that is neither a mapping nor a list item is prose (e.g.
    // "No shared folders found. Try restarting the VM."). Keep it aside.
    if (ind === 0 && !txt.startsWith('-') && !/^[^:]+:(\s|$)/.test(txt)) {
      prose.push(txt);
      continue;
    }
    items.push({ ind: ind, txt: txt });
  }
  let i = 0;

  function parseBlock(indent) {
    if (i >= items.length) return null;
    if (items[i].txt.startsWith('-')) return parseSeq(items[i].ind);
    return parseMap(items[i].ind);
  }

  function parseSeq(indent) {
    const arr = [];
    while (i < items.length && items[i].ind === indent && items[i].txt.startsWith('-')) {
      const rest = items[i].txt === '-' ? '' : items[i].txt.slice(2).trim();
      if (rest === '') {
        i++;
        arr.push(parseBlock(indent + 1));
      } else if (/^[^:]+:(\s|$)/.test(rest)) {
        // list item that is a map: first key inline, continuation keys indented by 2
        items[i] = { ind: indent + 2, txt: rest };
        arr.push(parseMap(indent + 2));
      } else {
        i++;
        arr.push(yamlScalar(rest));
      }
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (i < items.length && items[i].ind === indent && !items[i].txt.startsWith('-')) {
      const m = items[i].txt.match(/^([^:]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim().replace(/^'(.*)'$/, '$1');
      const val = m[2].trim();
      i++;
      if (val === '') {
        if (i < items.length && items[i].ind > indent) obj[key] = parseBlock(items[i].ind);
        else if (i < items.length && items[i].ind === indent && items[i].txt.startsWith('-')) obj[key] = parseSeq(indent);
        else obj[key] = null;
      } else {
        obj[key] = yamlScalar(val);
      }
    }
    return obj;
  }

  if (!items.length) {
    // Pure prose / table output — return it verbatim.
    return prose.length ? prose.join('\n') : null;
  }
  const res = parseBlock(items[0].ind);
  if (prose.length && res && typeof res === 'object' && !Array.isArray(res)) {
    res._note = prose.join(' ');
  }
  return res;
}

/* Parse vmcli YAML, but never fail hard: fall back to the raw text. */
function parseOrRaw(text) {
  if (!text || !text.trim()) return text;
  try {
    const v = parseYaml(text);
    if (v === null) return text;
    // A parsed result that lost most of the input means we mis-parsed
    // (e.g. a column-aligned table rather than YAML) — keep the raw text.
    if (typeof v === 'object' && v !== null) {
      const kept = JSON.stringify(v).length;
      if (kept < text.trim().length * 0.5) return text;
    }
    return v;
  } catch (e) {
    return text;
  }
}

/* ------------------------------------------------- inventory / VM lookup */

function inventoryPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'VMware', 'inventory.vmls');
}

function readInventory() {
  const p = inventoryPath();
  let text;
  try {
    text = decodeText(fs.readFileSync(p));
  } catch (e) {
    return [];
  }
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^vmlist(\d+)\.(\w+)\s*=\s*(.*)$/);
    if (!m) continue;
    const id = m[1];
    let val = m[3].trim();
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
    if (!map.has(id)) map.set(id, { id: id, name: '', vmx: '' });
    const vm = map.get(id);
    if (m[2] === 'config') vm.vmx = val;
    else if (m[2] === 'DisplayName') vm.name = val;
  }
  return Array.from(map.values()).filter((v) => v.vmx);
}

function runningVms() {
  let text;
  try {
    text = vmrun(['list']);
  } catch (e) {
    return [];
  }
  const res = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^Total running VMs/i.test(t)) continue;
    if (/\.vmx$/i.test(t)) res.push(t);
  }
  return res;
}

/** Normalize a .vmx path for the CLIs: forward slashes work on Windows and Linux. */
function normVmx(p) {
  return String(p).replace(/\\/g, '/');
}

function resolveVm(spec) {
  if (!spec) fail('A VM name or .vmx path is required.');
  spec = String(spec);
  if (/\.vmx$/i.test(spec)) {
    const abs = path.isAbsolute(spec) ? spec : path.resolve(spec);
    return { name: path.basename(abs, path.extname(abs)), vmx: normVmx(abs), id: null };
  }
  const inv = readInventory();
  const low = spec.toLowerCase();
  const byExact = inv.find((v) =>
    v.name.toLowerCase() === low ||
    path.basename(v.vmx).toLowerCase() === low ||
    path.basename(v.vmx, path.extname(v.vmx)).toLowerCase() === low ||
    v.id === spec
  );
  if (byExact) return { name: byExact.name || path.basename(byExact.vmx, '.vmx'), vmx: normVmx(byExact.vmx), id: byExact.id };
  const byPartial = inv.find((v) =>
    v.name.toLowerCase().indexOf(low) >= 0 || v.vmx.toLowerCase().indexOf(low) >= 0
  );
  if (byPartial) return { name: byPartial.name || path.basename(byPartial.vmx, '.vmx'), vmx: normVmx(byPartial.vmx), id: byPartial.id };
  const running = runningVms();
  const byRunning = running.find((p) => path.basename(p).toLowerCase().indexOf(low) >= 0);
  if (byRunning) return { name: path.basename(byRunning, '.vmx'), vmx: normVmx(byRunning), id: null };
  fail(
    'VM not found: "' + spec + '".\nKnown VMs:\n' +
    (inv.length ? inv.map((v) => '  ' + (v.name || path.basename(v.vmx)) + '  ->  ' + v.vmx).join('\n') : '  (inventory.vmls is empty)')
  );
}

function vmArg(args, idx) {
  return resolveVm(args[idx]);
}

/* --------------------------------------------------------- guest creds */

function guestCreds() {
  const u = process.env.VMWARE_GUEST_USER;
  if (!u) {
    fail(
      'Guest operations require VMware Tools credentials in the guest OS.\n' +
      'Set them as environment variables (do NOT pass them on the command line):\n' +
      '  VMWARE_GUEST_USER=<user>  VMWARE_GUEST_PASS=<pass>'
    );
  }
  return { user: u, pass: process.env.VMWARE_GUEST_PASS || '' };
}

function vmrunGuest(args) {
  const c = guestCreds();
  return vmrun(['-gu', c.user, '-gp', c.pass].concat(args));
}

function vmcliGuest(vmx, module, command, args) {
  const c = guestCreds();
  return vmcli(vmx, module, command, ['-u', c.user, '-p', c.pass].concat(args || []));
}

/* --------------------------------------------------------------- REST API */

function restBase() {
  const host = process.env.VMWARE_HOST || '127.0.0.1';
  const port = process.env.VMWARE_PORT || '8697';
  return 'http://' + host + ':' + port + '/api';
}

function restAvailable() {
  try {
    const res = spawnSync(process.execPath, ['-e',
      'const http=require("http");const u=process.argv[1];' +
      'const r=http.request(u,{method:"GET",timeout:2000},res=>{process.exit(0)});' +
      'r.on("error",()=>process.exit(1));r.on("timeout",()=>{r.destroy();process.exit(1)});r.end();',
      restBase() + '/vms'], { timeout: 5000, windowsHide: true });
    return res.status === 0;
  } catch (e) {
    return false;
  }
}

function rest(method, apiPath, body) {
  const url = restBase() + apiPath;
  const args = ['-e', `
const http=require('http');const https=require('https');
const url=process.argv[1], method=process.argv[2], body=process.argv[3]||null;
const u=new URL(url);
const mod=u.protocol==='https:'?https:http;
const auth=process.env.VMWARE_USERNAME?Buffer.from(process.env.VMWARE_USERNAME+':'+(process.env.VMWARE_PASSWORD||'')).toString('base64'):null;
const headers={};
if(body){headers['Content-Type']='application/json';}
if(auth){headers['Authorization']='Basic '+auth;}
const req=mod.request(u,{method,headers},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
  process.stdout.write(JSON.stringify({status:res.statusCode,body:d}));
});});
req.on('error',e=>{process.stdout.write(JSON.stringify({status:0,error:e.message}));});
if(body)req.write(body);
req.end();`, url, method, body ? JSON.stringify(body) : ''];
  const res = run(process.execPath, args, { timeout: 30000 });
  let parsed;
  try {
    parsed = JSON.parse(res.out);
  } catch (e) {
    fail('vmrest request failed (is vmrest running?): ' + (res.err || res.out));
  }
  if (!parsed || parsed.status === 0) {
    fail('vmrest is not reachable at ' + restBase() + '\n' +
      'Start it with:  "' + (findTool('vmrest') || 'vmrest.exe') + '"\n' +
      '(first run:  "' + (findTool('vmrest') || 'vmrest.exe') + '" -C  to configure credentials)');
  }
  if (parsed.status >= 400) {
    fail('vmrest HTTP ' + parsed.status + ': ' + parsed.body);
  }
  if (!parsed.body) return null;
  try {
    return JSON.parse(parsed.body);
  } catch (e) {
    return parsed.body;
  }
}

function needRest() {
  if (!restAvailable()) {
    fail(
      'vmrest is not running on ' + restBase() + '.\n' +
      'This operation needs the REST API (the CLIs cannot do it). Start it with:\n' +
      '  "' + (findTool('vmrest') || 'vmrest.exe') + '"\n' +
      '(run "' + (findTool('vmrest') || 'vmrest.exe') + '" -C once first to set credentials)'
    );
  }
}

/* The REST API identifies VMs by its own opaque hash id, which is NOT the
   inventory.vmls ItemID. Resolve it by matching the .vmx path. */
function restVmId(vmxPath) {
  const vms = rest('GET', '/vms') || [];
  const want = normVmx(vmxPath).toLowerCase();
  for (const v of vms) {
    if (v && v.path && normVmx(v.path).toLowerCase() === want) return v.id;
  }
  // Fall back to a loose basename match.
  const base = path.basename(normVmx(vmxPath)).toLowerCase();
  for (const v of vms) {
    if (v && v.path && path.basename(normVmx(v.path)).toLowerCase() === base) return v.id;
  }
  fail('Could not map "' + vmxPath + '" to a REST VM id. Is the VM registered in Workstation?');
}

/* ============================== commands ============================== */

const HELP = {
  vm: 'vm list [--power]        list registered VMs (and running ones)\n' +
      '   vm info <vm>            full config dump (power/chipset/nic/disk/snapshot/tools)\n' +
      '   vm running              list only running VMs',
  power: 'power status <vm>        power state as JSON\n' +
      '   power start <vm> [--nogui]\n' +
      '   power stop <vm> [--hard] [--soft]\n' +
      '   power reset <vm> [--hard]\n' +
      '   power suspend <vm> [--hard]\n' +
      '   power pause <vm> | power unpause <vm>',
  snapshot: 'snapshot list <vm>       list snapshots with uids\n' +
      '   snapshot take <vm> <name> [--memory] [--desc "..."]\n' +
      '   snapshot revert <vm> <name|uid>\n' +
      '   snapshot delete <vm> <name|uid> [--children]\n' +
      '   snapshot clone <vm> <name|uid> <dest.vmx> [--linked]',
  guest: 'guest ls <vm> <path>            list a directory in the guest\n' +
      '   guest mkdir <vm> <path>          create a directory\n' +
      '   guest rmdir <vm> <path>          delete a directory\n' +
      '   guest rm <vm> <path>             delete a file\n' +
      '   guest mv <vm> <from> <to>        move/rename\n' +
      '   guest copy-to <vm> <hostPath> <guestPath> [--overwrite]\n' +
      '   guest copy-from <vm> <guestPath> <hostPath> [--overwrite]\n' +
      '   guest run <vm> <program> [args...]   run a program (waits unless --no-wait)\n' +
      '   guest script <vm> <interpreter> <script>   run a script\n' +
      '   guest ps <vm>                   list guest processes\n' +
      '   guest kill <vm> <pid>           kill a guest process\n' +
      '   guest exists <vm> <path>        does a file exist?\n' +
      '   guest dir-exists <vm> <path>    does a directory exist?\n' +
      '   guest temp <vm>                 create a temp file in the guest\n' +
      '   guest env <vm>                  dump guest environment variables',
  shared: 'shared list <vm>          list shared folders\n' +
      '   shared add <vm> <name> <hostPath>\n' +
      '   shared remove <vm> <name>\n' +
      '   shared set <vm> <name> <hostPath> [--readonly]\n' +
      '   shared enable <vm> | shared disable <vm>',
  chipset: 'chipset query <vm>       cpu / memory / cores-per-socket\n' +
      '   chipset cpu <vm> <n>         set vCPU count\n' +
      '   chipset memory <vm> <mb>     set memory size (MB)\n' +
      '   chipset cores <vm> <n>       set cores per socket',
  config: 'config get <vm> [key]      read .vmx config params (ConfigParams)\n' +
      '   config set <vm> <key> <value> write one config param',
  disk: 'disk list <vm>            disks / cdroms\n' +
      '   disk create <vm> <file.vmdk> <size> [--adapter ide|sata|scsi|lsilogic] [--type 0-3]\n' +
      '   disk extend <vm> <label> <newSectors>   (label like scsi0:0)',
  nic: 'nic list <vm>             network adapters\n' +
      '   nic set-type <vm> <label> <bridged|nat|hostonly|custom>\n' +
      '   nic set-present <vm> <label> <true|false>\n' +
      '   nic set-connected <vm> <label> <true|false>\n' +
      '   nic set-device <vm> <label> <e1000|e1000e|vmxnet3|...>\n' +
      '   nic set-network <vm> <label> <vmnet name>\n' +
      '   nic purge <vm> <label>\n' +
      '   nic add <vm> <type> <vmnet>   (REST only — CLIs cannot add a NIC)',
  net: 'net list                 host virtual networks\n' +
      '   net portforward-list <vmnet>\n' +
      '   net portforward-set <vmnet> <tcp|udp> <hostPort> <guestIp> <guestPort> [desc]\n' +
      '   net portforward-delete <vmnet> <tcp|udp> <hostPort>\n' +
      '   net create <name> <nat|hostOnly>   (REST only)',
  tools: 'tools status <vm>        VMware Tools state\n' +
      '   tools install <vm> | tools upgrade <vm>',
  screen: 'screen capture <vm> <out.png>\n' +
      '   screen keys <vm> <keystrokes>   (vmrun typeKeystrokesInGuest)',
  device: 'device connect <vm> <name> | device disconnect <vm> <name>',
  vars: 'var read <vm> <runtimeConfig|guestEnv|guestVar> <name>\n' +
      '   var write <vm> <runtimeConfig|guestEnv|guestVar> <name> <value>',
  template: 'template create <vm> <out.vmtx> <name>\n' +
      '   template deploy <template.vmtx> [--dest <dir>] [--name <n>]',
  clone: 'clone <vm> <dest.vmx> [--full|--linked] [--snapshot <name>] [--name <n>]',
  vmnew: 'vmnew <name> <dir> [--guest <id>] [--custom <guesttype>]   create a new VM\n' +
      '   guest ids: 1 Other, 3 Win3.11, 5 Win95, 6 Win98, 7 WinME, 8 NT Workstation,\n' +
      '   9 NT Server, 10 Win2000 Pro, 11 Win2000 Server, 12 WinXP Pro, 13 WinXP Server',
  rest: 'rest status | rest vms | rest vm <id> | rest vm-create <parentId> <name>\n' +
      '   rest vm-delete <id> | rest vm-update <id> [--processors n] [--memory mb]\n' +
      '   rest power <id> | rest power-set <id> <on|off|shutdown|suspend|pause|unpause>\n' +
      '   rest nic-list <id> | rest nic-create <id> <type> <vmnet> | rest nic-delete <id> <idx>\n' +
      '   rest folder-list <id> | rest folder-create <id> <folderId> <hostPath> [--flags 4]\n' +
      '   rest folder-delete <id> <folderId> | rest ip <id>\n' +
      '   rest net-list | rest net-create <name> <type>\n' +
      '   rest pf-list <vmnet> | rest pf-set <vmnet> <proto> <port> <guestIp> <guestPort>\n' +
      '   rest pf-delete <vmnet> <proto> <port>',
  raw: 'raw vmcli <vmx> <module> <command> [args...]   escape hatch\n' +
      '   raw vmrun [args...]                             escape hatch',
};

function cmdVm(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  if (sub === 'list' || sub === undefined) {
    const inv = readInventory();
    const running = runningVms();
    const runningSet = new Set(running.map((p) => normVmx(p).toLowerCase()));
    let list = inv.map((v) => ({
      name: v.name || path.basename(v.vmx, '.vmx'),
      id: v.id,
      vmx: normVmx(v.vmx),
      running: runningSet.has(normVmx(v.vmx).toLowerCase()),
    }));
    for (const p of running) {
      const n = normVmx(p);
      if (!list.some((v) => v.vmx.toLowerCase() === n.toLowerCase())) {
        list.push({ name: path.basename(n, '.vmx'), id: null, vmx: n, running: true });
      }
    }
    if (flags.power) {
      for (const v of list) {
        try {
          const q = parseOrRaw(vmcli(v.vmx, 'Power', 'query'));
          v.power = (q && q.PowerState) ? q.PowerState : null;
        } catch (e) {
          v.power = null;
        }
      }
    }
    out(JSON.stringify(list, null, 2));
    return;
  }
  if (sub === 'running') {
    out(JSON.stringify(runningVms().map((p) => ({ name: path.basename(p, '.vmx'), vmx: normVmx(p) })), null, 2));
    return;
  }
  if (sub === 'info') {
    const vm = vmArg(pos, 1);
    const sections = [
      ['Power', vmcli(vm.vmx, 'Power', 'query')],
      ['Chipset', vmcli(vm.vmx, 'Chipset', 'query')],
      ['Ethernet', vmcli(vm.vmx, 'Ethernet', 'query')],
      ['Disk', vmcli(vm.vmx, 'Disk', 'query')],
      ['Snapshot', vmcli(vm.vmx, 'Snapshot', 'query')],
      ['HGFS', vmcli(vm.vmx, 'HGFS', 'query')],
      ['Tools', vmcli(vm.vmx, 'Tools', 'Query')],
    ];
    out('VM: ' + vm.name + '  (' + vm.vmx + ')\n');
    for (const [name, body] of sections) {
      out('===== ' + name + ' =====');
      out(body);
      out('');
    }
    return;
  }
  fail('Unknown vm subcommand: ' + sub + '\n' + HELP.vm);
}

function cmdPower(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'status': {
      const q = parseOrRaw(vmcli(vm.vmx, 'Power', 'query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'start':
      vmrun(['start', vm.vmx, flags.nogui ? 'nogui' : 'gui']);
      out('started: ' + vm.name);
      return;
    case 'stop':
      vmrun(['stop', vm.vmx, flags.hard ? 'hard' : 'soft']);
      out('stopped: ' + vm.name);
      return;
    case 'reset':
      vmrun(['reset', vm.vmx, flags.hard ? 'hard' : 'soft']);
      out('reset: ' + vm.name);
      return;
    case 'suspend':
      vmrun(['suspend', vm.vmx, flags.hard ? 'hard' : 'soft']);
      out('suspended: ' + vm.name);
      return;
    case 'pause':
      vmrun(['pause', vm.vmx]);
      out('paused: ' + vm.name);
      return;
    case 'unpause':
      vmrun(['unpause', vm.vmx]);
      out('unpaused: ' + vm.name);
      return;
    default:
      fail('Unknown power subcommand: ' + sub + '\n' + HELP.power);
  }
}

function snapshotUid(vm, nameOrUid) {
  if (/^\d+$/.test(nameOrUid)) return nameOrUid;
  const q = parseOrRaw(vmcli(vm.vmx, 'Snapshot', 'query'));
  const snaps = (q && q.snapshots) || [];
  for (const s of snaps) {
    if (s && s.displayName === nameOrUid) return String(s.uid);
  }
  fail('No snapshot named "' + nameOrUid + '" on ' + vm.name + '. Available: ' +
    (snaps.map((s) => s.displayName + ' (uid ' + s.uid + ')').join(', ') || '(none)'));
}

function cmdSnapshot(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'list': {
      const q = parseOrRaw(vmcli(vm.vmx, 'Snapshot', 'query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'take': {
      const name = pos[2];
      if (!name) fail('snapshot take needs a name.');
      const a = [];
      if (flags.memory) a.push('-m');
      if (flags.desc) a.push('-d', String(flags.desc));
      vmcli(vm.vmx, 'Snapshot', 'Take', [name].concat(a));
      out('snapshot taken: ' + name);
      return;
    }
    case 'revert': {
      const uid = snapshotUid(vm, pos[2]);
      vmcli(vm.vmx, 'Snapshot', 'Revert', [uid]);
      out('reverted to uid ' + uid);
      return;
    }
    case 'delete': {
      const uid = snapshotUid(vm, pos[2]);
      const a = [uid];
      if (flags.children) a.push('-d');
      vmcli(vm.vmx, 'Snapshot', 'Delete', a);
      out('deleted snapshot uid ' + uid);
      return;
    }
    case 'clone': {
      const uid = snapshotUid(vm, pos[2]);
      const dest = pos[3];
      if (!dest) fail('snapshot clone needs a destination .vmx path.');
      const a = [uid, dest];
      if (flags.linked) a.push('-l');
      vmcli(vm.vmx, 'Snapshot', 'Clone', a);
      out('cloned snapshot uid ' + uid + ' -> ' + dest);
      return;
    }
    default:
      fail('Unknown snapshot subcommand: ' + sub + '\n' + HELP.snapshot);
  }
}

function cmdGuest(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'ls': {
      const p = pos[2];
      if (!p) fail('guest ls needs a path.');
      const q = parseOrRaw(vmcliGuest(vm.vmx, 'Guest', 'ls', [p]));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'mkdir':
      vmcliGuest(vm.vmx, 'Guest', 'mkdir', [pos[2]]);
      out('created ' + pos[2]);
      return;
    case 'rmdir':
      vmcliGuest(vm.vmx, 'Guest', 'rmdir', pos[3] ? [pos[2], '-r'] : [pos[2]]);
      out('removed dir ' + pos[2]);
      return;
    case 'rm':
      vmcliGuest(vm.vmx, 'Guest', 'rm', [pos[2]]);
      out('removed ' + pos[2]);
      return;
    case 'mv': {
      const a = [pos[2], pos[3]];
      if (flags.overwrite) a.push('-o');
      vmcliGuest(vm.vmx, 'Guest', 'mv', a);
      out('moved ' + pos[2] + ' -> ' + pos[3]);
      return;
    }
    case 'copy-to': {
      const a = [pos[2], pos[3]];
      if (flags.overwrite) a.push('-o');
      vmcliGuest(vm.vmx, 'Guest', 'copyTo', a);
      out('copied ' + pos[2] + ' -> ' + pos[3]);
      return;
    }
    case 'copy-from': {
      const a = [pos[2], pos[3]];
      if (flags.overwrite) a.push('-o');
      vmcliGuest(vm.vmx, 'Guest', 'copyFrom', a);
      out('copied ' + pos[2] + ' -> ' + pos[3]);
      return;
    }
    case 'run': {
      const program = pos[2];
      if (!program) fail('guest run needs a program path.');
      const a = [vm.vmx];
      if (flags['no-wait']) a.push('-noWait');
      if (flags['active-window']) a.push('-activeWindow');
      if (flags.interactive) a.push('-interactive');
      a.push(program);
      for (let i = 3; i < pos.length; i++) a.push(pos[i]);
      const r = vmrunGuest(['runProgramInGuest'].concat(a));
      out(r || 'OK');
      return;
    }
    case 'script': {
      const a = [vm.vmx];
      if (flags['no-wait']) a.push('-noWait');
      if (flags['active-window']) a.push('-activeWindow');
      if (flags.interactive) a.push('-interactive');
      a.push(pos[2], pos[3]);
      const r = vmrunGuest(['runScriptInGuest'].concat(a));
      out(r || 'OK');
      return;
    }
    case 'ps': {
      const q = parseOrRaw(vmcliGuest(vm.vmx, 'Guest', 'ps', []));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'kill':
      vmcliGuest(vm.vmx, 'Guest', 'kill', [String(pos[2])]);
      out('killed pid ' + pos[2]);
      return;
    case 'exists': {
      const r = vmrunGuest(['fileExistsInGuest', vm.vmx, pos[2]]);
      out(String(r).trim() || 'false');
      return;
    }
    case 'dir-exists': {
      const r = vmrunGuest(['directoryExistsInGuest', vm.vmx, pos[2]]);
      out(String(r).trim() || 'false');
      return;
    }
    case 'temp': {
      const r = vmrunGuest(['CreateTempfileInGuest', vm.vmx]);
      out(String(r).trim());
      return;
    }
    case 'env': {
      const q = parseOrRaw(vmcliGuest(vm.vmx, 'Guest', 'env', []));
      out(JSON.stringify(q, null, 2));
      return;
    }
    default:
      fail('Unknown guest subcommand: ' + sub + '\n' + HELP.guest);
  }
}

function cmdShared(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'list': {
      const q = parseOrRaw(vmcli(vm.vmx, 'HGFS', 'query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'add':
      vmrun(['addSharedFolder', vm.vmx, pos[2], pos[3]]);
      out('added shared folder ' + pos[2]);
      return;
    case 'remove':
      vmrun(['removeSharedFolder', vm.vmx, pos[2]]);
      out('removed shared folder ' + pos[2]);
      return;
    case 'set':
      vmrun(['setSharedFolderState', vm.vmx, pos[2], pos[3], flags.readonly ? 'readonly' : 'writable']);
      out('set shared folder ' + pos[2]);
      return;
    case 'enable':
      vmrun(['enableSharedFolders', vm.vmx]);
      out('shared folders enabled');
      return;
    case 'disable':
      vmrun(['disableSharedFolders', vm.vmx]);
      out('shared folders disabled');
      return;
    default:
      fail('Unknown shared subcommand: ' + sub + '\n' + HELP.shared);
  }
}

function cmdChipset(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'query': {
      const q = parseOrRaw(vmcli(vm.vmx, 'Chipset', 'query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'cpu':
      vmcli(vm.vmx, 'Chipset', 'SetVCpuCount', [String(pos[2])]);
      out('vcpu count set to ' + pos[2]);
      return;
    case 'memory':
      vmcli(vm.vmx, 'Chipset', 'SetMemSize', [String(pos[2])]);
      out('memory set to ' + pos[2] + ' MB');
      return;
    case 'cores':
      vmcli(vm.vmx, 'Chipset', 'SetCoresPerSocket', [String(pos[2])]);
      out('cores per socket set to ' + pos[2]);
      return;
    default:
      fail('Unknown chipset subcommand: ' + sub + '\n' + HELP.chipset);
  }
}

function cmdConfig(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'get': {
      const q = parseOrRaw(vmcli(vm.vmx, 'ConfigParams', 'query'));
      if (pos[2]) {
        const key = pos[2];
        const v = (q && typeof q === 'object') ? q[key] : undefined;
        if (v === undefined) fail('No config param "' + key + '" (use `config get <vm>` to list all).');
        out(JSON.stringify(v, null, 2));
      } else {
        out(JSON.stringify(q, null, 2));
      }
      return;
    }
    case 'set':
      vmcli(vm.vmx, 'ConfigParams', 'SetEntry', [pos[2], pos[3]]);
      out('set ' + pos[2] + ' = ' + pos[3]);
      return;
    default:
      fail('Unknown config subcommand: ' + sub + '\n' + HELP.config);
  }
}

function cmdDisk(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'list': {
      const q = parseOrRaw(vmcli(vm.vmx, 'Disk', 'query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'create': {
      const file = pos[2];
      const size = pos[3];
      if (!file || !size) fail('disk create needs <file.vmdk> and <size>.');
      const a = ['-f', file, '-s', size, '-a', String(flags.adapter || 'lsilogic'), '-t', String(flags.type || '0')];
      vmcli(vm.vmx, 'Disk', 'Create', a);
      out('created disk ' + file + ' (' + size + ')');
      return;
    }
    case 'extend':
      vmcli(vm.vmx, 'Disk', 'Extend', [pos[2], pos[3]]);
      out('extended ' + pos[2]);
      return;
    default:
      fail('Unknown disk subcommand: ' + sub + '\n' + HELP.disk);
  }
}

function cmdNic(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'list': {
      const q = parseOrRaw(vmcli(vm.vmx, 'Ethernet', 'query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'set-type':
      vmcli(vm.vmx, 'Ethernet', 'SetConnectionType', [pos[2], pos[3]]);
      out('nic type set');
      return;
    case 'set-present':
      vmcli(vm.vmx, 'Ethernet', 'SetPresent', [pos[2], bool(pos[3]) ? 'true' : 'false']);
      out('nic present set');
      return;
    case 'set-connected':
      vmcli(vm.vmx, 'Ethernet', 'SetStartConnected', [pos[2], bool(pos[3]) ? 'true' : 'false']);
      out('nic startConnected set');
      return;
    case 'set-device':
      vmcli(vm.vmx, 'Ethernet', 'SetVirtualDevice', [pos[2], pos[3]]);
      out('nic virtual device set');
      return;
    case 'set-network':
      vmcli(vm.vmx, 'Ethernet', 'SetNetworkName', [pos[2], pos[3]]);
      out('nic network name set');
      return;
    case 'purge':
      vmcli(vm.vmx, 'Ethernet', 'Purge', [pos[2]]);
      out('nic purged');
      return;
    case 'add':
      needRest();
      const body = { type: pos[2], vmnet: pos[3] };
      out(JSON.stringify(rest('POST', '/vms/' + encodeURIComponent(restVmId(vm.vmx)) + '/nic', body), null, 2));
      return;
    default:
      fail('Unknown nic subcommand: ' + sub + '\n' + HELP.nic);
  }
}

function cmdNet(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  switch (sub) {
    case 'list':
      out(vmrun(['listHostNetworks']));
      return;
    case 'portforward-list':
      out(vmrun(['listPortForwardings', pos[1]]));
      return;
    case 'portforward-set': {
      const a = [pos[1], pos[2], pos[3], pos[4], pos[5]];
      if (pos[6]) a.push(pos[6]);
      vmrun(['setPortForwarding'].concat(a));
      out('port forwarding set');
      return;
    }
    case 'portforward-delete':
      vmrun(['deletePortForwarding', pos[1], pos[2], pos[3]]);
      out('port forwarding deleted');
      return;
    case 'create':
      needRest();
      out(JSON.stringify(rest('POST', '/vmnets', { name: pos[1], type: pos[2] }), null, 2));
      return;
    default:
      fail('Unknown net subcommand: ' + sub + '\n' + HELP.net);
  }
}

function cmdTools(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'status': {
      const q = parseOrRaw(vmcli(vm.vmx, 'Tools', 'Query'));
      out(JSON.stringify(q, null, 2));
      return;
    }
    case 'install':
      vmrun(['installTools', vm.vmx]);
      out('tools install started');
      return;
    case 'upgrade':
      vmcli(vm.vmx, 'Tools', 'Upgrade', []);
      out('tools upgrade started');
      return;
    default:
      fail('Unknown tools subcommand: ' + sub + '\n' + HELP.tools);
  }
}

function cmdScreen(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'capture':
      // vmcli MKS captureScreenshot works without guest credentials; vmrun's
      // captureScreen requires a guest login. Try vmcli first, fall back to vmrun.
      try {
        vmcli(vm.vmx, 'MKS', 'captureScreenshot', [pos[2]]);
        out('screenshot saved: ' + pos[2]);
      } catch (e) {
        vmrun(['captureScreen', vm.vmx, pos[2]]);
        out('screenshot saved: ' + pos[2]);
      }
      return;
    case 'keys':
      vmrunGuest(['typeKeystrokesInGuest', vm.vmx, pos[2]]);
      out('keystrokes sent');
      return;
    default:
      fail('Unknown screen subcommand: ' + sub + '\n' + HELP.screen);
  }
}

function cmdDevice(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'connect':
      vmrun(['connectNamedDevice', vm.vmx, pos[2]]);
      out('device connected: ' + pos[2]);
      return;
    case 'disconnect':
      vmrun(['disconnectNamedDevice', vm.vmx, pos[2]]);
      out('device disconnected: ' + pos[2]);
      return;
    default:
      fail('Unknown device subcommand: ' + sub + '\n' + HELP.device);
  }
}

function cmdVars(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  const vm = vmArg(pos, 1);
  switch (sub) {
    case 'read':
      out(vmrun(['readVariable', vm.vmx, pos[2], pos[3]]));
      return;
    case 'write':
      vmrun(['writeVariable', vm.vmx, pos[2], pos[3], pos[4]]);
      out('variable written');
      return;
    default:
      fail('Unknown var subcommand: ' + sub + '\n' + HELP.vars);
  }
}

function cmdTemplate(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  switch (sub) {
    case 'create': {
      const vm = resolveVm(pos[1]);
      vmcli(vm.vmx, 'VMTemplate', 'Create', ['-p', pos[2], '-n', pos[3]]);
      out('template created: ' + pos[2]);
      return;
    }
    case 'deploy': {
      const a = ['-p', pos[1]];
      if (flags.dest) a.push('-d', String(flags.dest));
      if (flags.name) a.push('-n', String(flags.name));
      vmcli(null, 'VMTemplate', 'Deploy', a);
      out('template deployed');
      return;
    }
    default:
      fail('Unknown template subcommand: ' + sub + '\n' + HELP.template);
  }
}

function cmdClone(args) {
  const { flags, pos } = splitArgs(args);
  const vm = vmArg(pos, 0);
  const dest = pos[1];
  if (!dest) fail('clone needs a destination .vmx path.');
  const a = [vm.vmx, dest, flags.full ? 'full' : 'linked'];
  if (flags.snapshot) a.push('-snapshot=' + flags.snapshot);
  if (flags.name) a.push('-cloneName=' + flags.name);
  vmrun(['clone'].concat(a));
  out('cloned ' + vm.name + ' -> ' + dest);
}

function cmdVmNew(args) {
  const { flags, pos } = splitArgs(args);
  const name = pos[0];
  const dir = pos[1];
  if (!name || !dir) fail('vmnew needs <name> and <dir>.\n' + HELP.vmnew);
  const a = ['-n', name, '-d', dir];
  if (flags.custom) a.push('-c', String(flags.custom));
  else a.push('-g', String(flags.guest || '13'));
  vmcli(null, 'VM', 'Create', a);
  out('created VM ' + name + ' in ' + dir);
}

function cmdRest(args) {
  const { flags, pos } = splitArgs(args);
  const sub = pos[0];
  if (sub === 'status') {
    const ok = restAvailable();
    out(JSON.stringify({
      reachable: ok,
      baseUrl: restBase(),
      vmrestPath: findTool('vmrest'),
      credentialsConfigured: !!(process.env.VMWARE_USERNAME && process.env.VMWARE_PASSWORD),
    }, null, 2));
    return;
  }
  needRest();

  /* Accept either a raw REST VM id or a VM name / .vmx path. */
  function vid(spec) {
    if (!spec) fail('A VM id or name is required.');
    if (/^[A-Z0-9]{30}$/.test(spec)) return spec;   // already a REST id
    try {
      return restVmId(resolveVm(spec).vmx);
    } catch (e) {
      return spec;   // let the server produce the error
    }
  }

  switch (sub) {
    case 'vms':
      out(JSON.stringify(rest('GET', '/vms'), null, 2));
      return;
    case 'vm':
      out(JSON.stringify(rest('GET', '/vms/' + encodeURIComponent(vid(pos[1]))), null, 2));
      return;
    case 'vm-create':
      out(JSON.stringify(rest('POST', '/vms', { name: pos[2], parentId: vid(pos[1]) }), null, 2));
      return;
    case 'vm-delete':
      rest('DELETE', '/vms/' + encodeURIComponent(vid(pos[1])));
      out('deleted ' + pos[1]);
      return;
    case 'vm-update': {
      const body = {};
      if (flags.processors) body.processors = parseInt(flags.processors, 10);
      if (flags.memory) body.memory = parseInt(flags.memory, 10);
      out(JSON.stringify(rest('PUT', '/vms/' + encodeURIComponent(vid(pos[1])), body), null, 2));
      return;
    }
    case 'power':
      out(JSON.stringify(rest('GET', '/vms/' + encodeURIComponent(vid(pos[1])) + '/power'), null, 2));
      return;
    case 'power-set':
      out(JSON.stringify(rest('PUT', '/vms/' + encodeURIComponent(vid(pos[1])) + '/power', { operation: pos[2] }), null, 2));
      return;
    case 'nic-list':
      out(JSON.stringify(rest('GET', '/vms/' + encodeURIComponent(vid(pos[1])) + '/nic'), null, 2));
      return;
    case 'nic-create':
      out(JSON.stringify(rest('POST', '/vms/' + encodeURIComponent(vid(pos[1])) + '/nic', { type: pos[2], vmnet: pos[3] }), null, 2));
      return;
    case 'nic-delete':
      rest('DELETE', '/vms/' + encodeURIComponent(vid(pos[1])) + '/nic/' + encodeURIComponent(pos[2]));
      out('nic deleted');
      return;
    case 'folder-list':
      out(JSON.stringify(rest('GET', '/vms/' + encodeURIComponent(vid(pos[1])) + '/sharedfolders'), null, 2));
      return;
    case 'folder-create': {
      const body = { folder_id: pos[2], host_path: pos[3], flags: flags.flags ? parseInt(flags.flags, 10) : 4 };
      out(JSON.stringify(rest('POST', '/vms/' + encodeURIComponent(vid(pos[1])) + '/sharedfolders', body), null, 2));
      return;
    }
    case 'folder-delete':
      rest('DELETE', '/vms/' + encodeURIComponent(vid(pos[1])) + '/sharedfolders/' + encodeURIComponent(pos[2]));
      out('shared folder deleted');
      return;
    case 'ip':
      out(JSON.stringify(rest('GET', '/vms/' + encodeURIComponent(vid(pos[1])) + '/ip'), null, 2));
      return;
    case 'net-list':
      out(JSON.stringify(rest('GET', '/vmnet'), null, 2));
      return;
    case 'net-create':
      out(JSON.stringify(rest('POST', '/vmnets', { name: pos[1], type: pos[2] }), null, 2));
      return;
    case 'pf-list':
      out(JSON.stringify(rest('GET', '/vmnet/' + encodeURIComponent(pos[1]) + '/portforward'), null, 2));
      return;
    case 'pf-set':
      out(JSON.stringify(rest('PUT', '/vmnet/' + encodeURIComponent(pos[1]) + '/portforward/' + encodeURIComponent(pos[2]) + '/' + encodeURIComponent(pos[3]),
        { guestIp: pos[4], guestPort: parseInt(pos[5], 10) }), null, 2));
      return;
    case 'pf-delete':
      rest('DELETE', '/vmnet/' + encodeURIComponent(pos[1]) + '/portforward/' + encodeURIComponent(pos[2]) + '/' + encodeURIComponent(pos[3]));
      out('port forward deleted');
      return;
    default:
      fail('Unknown rest subcommand: ' + sub + '\n' + HELP.rest);
  }
}

function cmdRaw(args) {
  const which = args[0];
  if (which === 'vmrun') {
    out(vmrun(args.slice(1)));
    return;
  }
  if (which === 'vmcli') {
    const rest_ = args.slice(1);
    let vmx = null;
    if (rest_.length && /\.vmx$/i.test(rest_[0])) vmx = rest_.shift();
    const module = rest_.shift();
    const command = rest_.shift();
    out(vmcli(vmx, module, command, rest_));
    return;
  }
  fail('raw needs `vmrun` or `vmcli`.\n' + HELP.raw);
}

/* ------------------------------------------------------------------ main */

const GROUPS = {
  vm: cmdVm,
  power: cmdPower,
  snapshot: cmdSnapshot,
  guest: cmdGuest,
  shared: cmdShared,
  chipset: cmdChipset,
  config: cmdConfig,
  disk: cmdDisk,
  nic: cmdNic,
  net: cmdNet,
  tools: cmdTools,
  screen: cmdScreen,
  device: cmdDevice,
  vars: cmdVars,
  template: cmdTemplate,
  clone: cmdClone,
  vmnew: cmdVmNew,
  rest: cmdRest,
  raw: cmdRaw,
};

function help(topic) {
  if (topic && HELP[topic]) {
    out(HELP[topic]);
    return;
  }
  out('vmware.js — control VMware Workstation VMs via vmrun / vmcli (no MCP, no daemon)\n');
  out('Usage: node vmware.js <group> <command> [args...]');
  out('');
  out('Groups:');
  for (const k of Object.keys(HELP)) {
    out('  ' + k.padEnd(10) + HELP[k].split('\n')[0]);
  }
  out('');
  out('Guest operations need: VMWARE_GUEST_USER / VMWARE_GUEST_PASS (env vars).');
  out('REST operations need vmrest running (see `rest status`).');
  out('');
  out('Run `node vmware.js help <group>` for details.');
}

function main(argv) {
  const g = argv[0];
  if (!g || g === 'help' || g === '--help' || g === '-h') {
    help(argv[1]);
    return;
  }
  const fn = GROUPS[g];
  if (!fn) {
    process.stderr.write('Unknown group: ' + g + '\n\n');
    help();
    process.exit(2);
  }
  fn(argv.slice(1));
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
  process.exit(e && e.vmExit ? e.vmExit : 1);
}
