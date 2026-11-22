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

/**
 * Flags that take a value. Everything else is boolean.
 *
 * Without this, `--guest 64` parsed as `guest: true` with `64` left as a
 * positional argument, so every documented `<flag> <value>` form silently
 * passed the literal string "true" to the CLI.
 */
const VALUE_FLAGS = new Set([
  'guest', 'custom', 'desc', 'adapter', 'type', 'snapshot', 'name',
  'dest', 'processors', 'flags',
]);

/**
 * `--memory` is boolean for `snapshot take` (save RAM) and a value for
 * `rest vm-update` (megabytes). Treat it as value-taking only when a plain
 * number follows, which is unambiguous for both callers.
 */
const NUMERIC_VALUE_FLAGS = new Set(['memory']);

function looksLikeNumber(v) {
  return /^-?\d+$/.test(String(v || ''));
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
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      const takesNext =
        next !== undefined &&
        !String(next).startsWith('--') &&
        (VALUE_FLAGS.has(body) || (NUMERIC_VALUE_FLAGS.has(body) && looksLikeNumber(next)));
      if (takesNext) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
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

const DEFAULT_TIMEOUT_MS = 120000;
/** File transfers are slow and legitimately long; a 2-minute cap is nonsense there. */
const TRANSFER_TIMEOUT_MS = 3600 * 1000;

/** --timeout <seconds> from the command line; null means "not given". 0 = no limit. */
let cliTimeoutMs = null;

function parseTimeout(v) {
  const n = Number(String(v).trim());
  if (!isFinite(n) || n < 0) fail('--timeout expects a number of seconds (0 = no limit), got: ' + v);
  return n === 0 ? 0 : Math.round(n * 1000);
}

/**
 * Pull `--timeout N` / `--timeout=N` out of argv before dispatch.
 *
 * A guest command may legitimately contain the literal string `--timeout`
 * (e.g. `guest exec vm slowtool --timeout 5`). Everything after `--` is left
 * alone, so write `guest exec vm -- slowtool --timeout 5` in that case.
 */
function extractTimeout(argv) {
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push.apply(rest, argv.slice(i));
      break;
    }
    if (a === '--timeout') {
      if (i + 1 >= argv.length) fail('--timeout needs a value in seconds (0 = no limit).');
      cliTimeoutMs = parseTimeout(argv[++i]);
      continue;
    }
    if (a.indexOf('--timeout=') === 0) {
      cliTimeoutMs = parseTimeout(a.slice('--timeout='.length));
      continue;
    }
    rest.push(a);
  }
  return rest;
}

/** Flags whose next argv element is a secret, masked in any printed command line. */
const SECRET_FLAGS = new Set(['-gp', '-p', '--password', '--gp']);

/**
 * Render an argv for humans without leaking guest credentials.
 *
 * Error messages end up in terminals, CI logs and agent transcripts; the whole
 * point of taking credentials from env vars was to keep them out of those.
 */
function redact(args) {
  const shown = [];
  for (let i = 0; i < args.length; i++) {
    shown.push(args[i]);
    if (SECRET_FLAGS.has(args[i]) && i + 1 < args.length) {
      shown.push('***');
      i++;
    }
  }
  return shown.join(' ');
}

function effectiveTimeout(opts) {
  if (opts && opts.timeout !== undefined && opts.timeout !== null) return opts.timeout;
  if (cliTimeoutMs !== null) return cliTimeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

function transferTimeout() {
  return cliTimeoutMs !== null ? cliTimeoutMs : TRANSFER_TIMEOUT_MS;
}

function run(exe, args, opts) {
  opts = opts || {};
  const timeout = effectiveTimeout(opts);
  const res = spawnSync(exe, args, {
    windowsHide: true,
    timeout: timeout,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    env: process.env,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') fail('Executable not found: ' + exe);
    if (res.error.code === 'ETIMEDOUT') {
      fail('Timed out after ' + timeout + 'ms: ' + exe + ' ' + redact(args) +
        '\nRaise it with --timeout <seconds> (0 = no limit), or check that the guest is responsive.');
    }
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

/* Split `key: value` out of one mapping line.
 *
 * The key may be single-quoted and may contain a colon — `'sata0:0.present':
 * TRUE` is ordinary vmcli output. Splitting on the first colon yields the key
 * `'sata0` and drops the entry from the result entirely, which silently makes
 * every device-slot lookup come back empty. So match a quoted key first. */
function splitYamlEntry(txt) {
  let m = txt.match(/^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*:\s*(.*)$/);
  if (m) return { key: m[1].slice(1, -1), val: m[2], quoted: true };
  m = txt.match(/^([^:]+):\s*(.*)$/);
  if (m) return { key: m[1].trim(), val: m[2], quoted: false };
  return null;
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
    const entry = splitYamlEntry(txt);
    if (ind === 0 && !txt.startsWith('-') && !entry) {
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
      } else if (splitYamlEntry(rest)) {
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
      const entry = splitYamlEntry(items[i].txt);
      if (!entry) { i++; continue; }
      const key = entry.key;
      const val = entry.val.trim();
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

/**
 * Guest call that returns the raw result instead of exiting.
 *
 * Some guest queries encode their answer in the exit code (`fileExistsInGuest`
 * returns 127 for "does not exist"), so they must not go through runOrDie.
 */
function vmrunGuestRaw(args, opts) {
  const c = guestCreds();
  return run(vmrunPath(), ['-T', 'ws', '-gu', c.user, '-gp', c.pass].concat(args), opts);
}

/** Strip the `See 'vmcli.exe ... --help'.` trailer VMware appends to every error. */
function guestError(r) {
  const text = (((r && r.out) || '') + '\n' + ((r && r.err) || ''))
    .replace(/\s*See '[^']*'\.?\s*/gi, ' ')
    .trim();
  return text || ('Guest operation failed (exit code ' + (r && r.code) + ')');
}

/** Turn a failed raw guest call into an exception, keeping the real message. */
function guestOrDie(r, what) {
  if (r.code === 0) return ((r.out || '').trim());
  fail(guestError(r) + (what ? '\n(while ' + what + ')' : ''));
}

function vmcliGuest(vmx, module, command, args) {
  const c = guestCreds();
  return vmcli(vmx, module, command, ['-u', c.user, '-p', c.pass].concat(args || []));
}

/* --------------------------------------------------------------- REST API */

/*
 * Credentials come in two flavours and the names keep them apart:
 *   VMWARE_GUEST_USER / VMWARE_GUEST_PASS  — login inside the guest OS
 *   VMWARE_REST_USER / VMWARE_REST_PASSWORD — vmrest's HTTP basic auth
 * A bare VMWARE_PASSWORD would be indistinguishable from the guest one and
 * collides with unrelated tooling, so it is deliberately not read.
 */
function restBase() {
  const host = process.env.VMWARE_REST_HOST || '127.0.0.1';
  const port = process.env.VMWARE_REST_PORT || '8697';
  return 'http://' + host + ':' + port + '/api';
}

function restCredentials() {
  const user = process.env.VMWARE_REST_USER;
  if (!user) return null;
  return { user: user, pass: process.env.VMWARE_REST_PASSWORD || '' };
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
// Read from the environment rather than argv so the credential never shows
// up in a process listing.
const ru=process.env.VMWARE_REST_USER, rp=process.env.VMWARE_REST_PASSWORD||'';
const auth=ru?Buffer.from(ru+':'+rp).toString('base64'):null;
const headers={};
// vmrest only accepts its own media type on writes; a plain application/json
// is answered with HTTP 406 "Content type not supported".
if(body){headers['Content-Type']='application/vnd.vmware.vmw.rest-v1+json';headers['Accept']='application/vnd.vmware.vmw.rest-v1+json';}
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
      '   snapshot clone <vm> <name|uid> <dest.vmx> [--linked] [--name <n>]',
  guest: 'guest ls <vm> <path> [--long]  list a directory (names; --long = raw detail table)\n' +
      '   guest mkdir <vm> <path>          create a directory\n' +
      '   guest rmdir <vm> <path>          delete a directory\n' +
      '   guest rm <vm> <path>             delete a file\n' +
      '   guest mv <vm> <from> <to>        move/rename\n' +
      '   guest copy-to <vm> <hostPath> <guestPath>      copy one file in\n' +
      '   guest copy-from <vm> <guestPath> <hostPath>    copy one file out\n' +
      '   guest put-dir <vm> <hostDir> <guestDir>        copy a tree in\n' +
      '   guest get-dir <vm> <guestDir> <hostDir>        copy a tree out\n' +
      '   guest exec <vm> <command...>     run and CAPTURE stdout+stderr+exit code\n' +
      '   guest run <vm> <program> [args...]   fire-and-forget (no output captured)\n' +
      '   guest script <vm> <interpreter> <script>   run a script\n' +
      '   guest ps <vm>                   list guest processes\n' +
      '   guest kill <vm> <pid>           kill a guest process\n' +
      '   guest exists <vm> <path>        print true/false, exit 0 either way\n' +
      '   guest dir-exists <vm> <path>    same, for a directory\n' +
      '   guest ready <vm>                wait until guest ops actually work\n' +
      '   guest temp <vm>                 create a temp file in the guest\n' +
      '   guest env <vm>                  dump guest environment variables',
  shared: 'shared list <vm>          list shared folders\n' +
      '   shared add <vm> <name> <hostPath>\n' +
      '   shared remove <vm> <name>\n' +
      '   shared set <vm> <name> <hostPath> [--readonly]\n' +
      '   shared enable <vm> | shared disable <vm>',
  chipset: 'chipset query <vm>       cpu / memory / cores-per-socket\n' +
      '   chipset cpu <vm> <n>         set vCPU count   (VM must be powered off)\n' +
      '   chipset memory <vm> <mb>     set memory (MB)  (VM must be powered off)\n' +
      '   chipset cores <vm> <n>       set cores/socket (VM must be powered off)',
  config: 'config get <vm> [key]      read .vmx config params (ConfigParams)\n' +
      '   config set <vm> <key> <value> write one config param',
  disk: 'disk list <vm>            disks / cdroms\n' +
      '   disk create <vm> <file.vmdk> <size> [--adapter ide|sata|scsi|lsilogic] [--type 0-3]\n' +
      '     <size> needs a unit — 512MB, 50GB. A bare number is rejected by vmcli.\n' +
      '   disk extend <vm> <label> <newSectors>   (label like scsi0:0)\n' +
      '   disk remove <vm> <label> [--delete-file]   detach (default) or also delete the .vmdk',
  nic: 'nic list <vm>             network adapters\n' +
      '   nic set-type <vm> <label> <bridged|nat|hostonly|custom>\n' +
      '   nic set-present <vm> <label> <true|false>\n' +
      '   nic set-connected <vm> <label> <true|false>\n' +
      '   nic set-device <vm> <label> <e1000|e1000e|vmxnet3|...>\n' +
      '   nic set-network <vm> <label> <vmnet name>\n' +
      '   nic purge <vm> <label>\n' +
      '   nic add <vm> <type> [vmnet]   (REST only — CLIs cannot add a NIC)\n' +
      '     type is bridged|nat|hostonly|custom; <vmnet> only applies to custom.\n' +
      '     The VM must be powered off.',
  net: 'net list                 host virtual networks\n' +
      '   net portforward-list <vmnet>\n' +
      '   net portforward-set <vmnet> <tcp|udp> <hostPort> <guestIp> <guestPort> [desc]\n' +
      '   net portforward-delete <vmnet> <tcp|udp> <hostPort>\n' +
      '   net create <name> <nat|hostOnly>   (REST only)',
  tools: 'tools status <vm>        VMware Tools state\n' +
      '   tools install <vm> | tools upgrade <vm>',
  screen: 'screen capture <vm> <out.png>     (vmcli MKS — no guest credentials needed)\n' +
      '   screen keys <vm> <keystrokes>        (vmcli MKS, falls back to vmrun)\n' +
      '     Types literal text; <Enter> <Tab> <Space> are translated.',
  device: 'device connect <vm> <name> | device disconnect <vm> <name>',
  vars: 'var read <vm> <runtimeConfig|guestEnv|guestVar> <name>\n' +
      '   var write <vm> <runtimeConfig|guestEnv|guestVar> <name> <value>',
  template: 'template create <vm> <out.vmtx> <name>\n' +
      '   template deploy <template.vmtx>      (vmcli: -p only; VM created beside it)',
  clone: 'clone <vm> <dest.vmx> [--full|--linked] [--snapshot <name>] [--name <n>]',
  vmnew: 'vmnew <name> <dir> [--guest <guestos>]   create a new VM\n' +
      '   <guestos> is a VMware guestOS name, e.g. rhel9-64, rockylinux-64, ubuntu-64,\n' +
      '   windows9-64. Defaults to other6xlinux-64. The `-g` id list in vmcli --help\n' +
      '   is stale: vmcli rejects numeric ids and wants a name.',
  rest: 'rest status | rest vms | rest vm <id> | rest vm-create <parentId> <name>\n' +
      '   rest vm-delete <id> | rest vm-update <id> [--processors n] [--memory mb]\n' +
      '   rest power <id> | rest power-set <id> <on|off|shutdown|suspend|pause|unpause>\n' +
      '   rest nic-list <id> | rest nic-create <id> <type> [vmnet] | rest nic-delete <id> <idx>\n' +
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

function snapshotList(vm) {
  const q = parseOrRaw(vmcli(vm.vmx, 'Snapshot', 'query'));
  return (q && q.snapshots) || [];
}

function snapshotUid(vm, nameOrUid) {
  if (/^\d+$/.test(nameOrUid)) return nameOrUid;
  const snaps = snapshotList(vm);
  for (const s of snaps) {
    if (s && s.displayName === nameOrUid) return String(s.uid);
  }
  fail('No snapshot named "' + nameOrUid + '" on ' + vm.name + '. Available: ' +
    (snaps.map((s) => s.displayName + ' (uid ' + s.uid + ')').join(', ') || '(none)'));
}

// vmrun wants the display name, not the uid.
function snapshotName(vm, nameOrUid) {
  if (!/^\d+$/.test(nameOrUid)) return nameOrUid;
  const snaps = snapshotList(vm);
  for (const s of snaps) {
    if (s && String(s.uid) === String(nameOrUid)) return s.displayName;
  }
  fail('No snapshot with uid ' + nameOrUid + ' on ' + vm.name + '.');
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
      // vmcli Snapshot Revert refuses a running VM ("VM is in an invalid state
      // (online)"), and reverting is exactly when you want to be able to do it.
      // vmrun revertToSnapshot works in either power state.
      const name = snapshotName(vm, pos[2]);
      vmrun(['revertToSnapshot', vm.vmx, name]);
      out('reverted to "' + name + '"');
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
      // vmcli takes a third positional: a short name for the new snapshot,
      // which is also what names the resulting VM. Default it from the file.
      const name = flags.name || path.basename(dest, path.extname(dest));
      const a = [uid, dest, String(name)];
      if (flags.linked) a.push('-l');
      vmcli(vm.vmx, 'Snapshot', 'Clone', a);
      out('cloned snapshot uid ' + uid + ' -> ' + dest);
      return;
    }
    default:
      fail('Unknown snapshot subcommand: ' + sub + '\n' + HELP.snapshot);
  }
}

/* ------------------------------------------------------------ guest utils */

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Guest OS family, from the .vmx `guestOS` value.
 *
 * Used to pick a shell and a path separator. Anything unrecognised is treated
 * as POSIX — that is the safer default when the guest is not Windows.
 */
function osFamilyOf(guestOs) {
  const g = String(guestOs || '').toLowerCase();
  return /^win|windows/.test(g) ? 'windows' : 'linux';
}

function guestOsFamily(vm) {
  try {
    const q = parseOrRaw(vmcli(vm.vmx, 'ConfigParams', 'query'));
    if (q && typeof q === 'object' && q.guestOS) return osFamilyOf(q.guestOS);
  } catch (e) { /* fall through */ }
  return 'linux';
}

function guestFamilyInfo(vm) {
  const windows = guestOsFamily(vm) === 'windows';
  return { windows: windows, sep: windows ? '\\' : '/' };
}

function guestJoin(family, base, name) {
  const sep = family === 'windows' ? '\\' : '/';
  const trimmed = String(name).split('/').join(sep);
  return String(base).replace(/[\\/]+$/, '') + sep + trimmed;
}

/** true / false; throws only when the guest itself is unusable. */
function guestPathExists(vm, guestPath, kind) {
  const cmd = kind === 'dir' ? 'directoryExistsInGuest' : 'fileExistsInGuest';
  const r = vmrunGuestRaw([cmd, vm.vmx, guestPath]);
  const text = ((r.out || '') + '\n' + (r.err || '')).trim();
  // The "does not exist" wording is a normal answer, not an error.
  if (/does not exist/i.test(text)) return false;
  if (/\bexists\b/i.test(text) && !/^error/im.test(text)) return true;
  fail(guestError(r) + '\n(while checking ' + guestPath + ')');
}

/** Same, but answers false instead of throwing. Used for probes. */
function guestPathExistsQuiet(vm, guestPath, kind) {
  try {
    return guestPathExists(vm, guestPath, kind);
  } catch (e) {
    return false;
  }
}

function ensureGuestDir(vm, guestPath) {
  const r = vmrunGuestRaw(['createDirectoryInGuest', vm.vmx, guestPath]);
  if (r.code === 0) return;
  const msg = guestError(r);
  if (/already exists/i.test(msg)) return;
  fail(msg + '\n(while creating ' + guestPath + ')');
}

/** Copy one file; vmrun overwrites the destination silently. */
function guestCopyTo(vm, hostPath, guestPath) {
  const r = vmrunGuestRaw(['copyFileFromHostToGuest', vm.vmx, hostPath, guestPath], { timeout: transferTimeout() });
  if (r.code !== 0) fail(guestError(r) + '\n(while copying ' + hostPath + ' -> ' + guestPath + ')');
}

function guestCopyFrom(vm, guestPath, hostPath) {
  const r = vmrunGuestRaw(['copyFileFromGuestToHost', vm.vmx, guestPath, hostPath], { timeout: transferTimeout() });
  if (r.code !== 0) fail(guestError(r) + '\n(while copying ' + guestPath + ' -> ' + hostPath + ')');
}

function guestListNames(vm, guestPath) {
  const r = vmrunGuestRaw(['listDirectoryInGuest', vm.vmx, guestPath]);
  if (r.code !== 0) fail(guestError(r) + '\n(while listing ' + guestPath + ')');
  return String(r.out || '')
    .split(/\r?\n/)
    .slice(1) // drop the "Directory list: N" header
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
}

function walkLocalDir(root) {
  const entries = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let list;
    try {
      list = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      fail('Cannot read host directory ' + abs + ': ' + e.message);
    }
    for (const ent of list) {
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        entries.push({ rel: childRel, dir: true });
        stack.push(childRel);
      } else if (ent.isFile()) {
        entries.push({ rel: childRel, dir: false });
      }
    }
  }
  return entries;
}

/**
 * Run a command in the guest and bring back its stdout/stderr/exit code.
 *
 * vmrun cannot capture output, so the command is redirected to a temp file in
 * the guest and copied back.
 *
 * The command is shipped as a script file invoked by a single space-free token
 * (`cmd /c C:\Windows\Temp\x.bat`). Passing the command inline does not work:
 * vmrun re-quotes any argument containing spaces, cmd.exe then strips only one
 * of the resulting quotes, and the last character of the command leaks into the
 * output as a stray `"`. A file sidesteps quoting entirely.
 */
function guestExecCapture(vm, cmdline) {
  const family = guestFamilyInfo(vm);
  const stamp = process.pid + '-' + Date.now();
  const ext = family.windows ? '.bat' : '.sh';

  const remoteDir = family.windows ? 'C:\\Windows\\Temp' : '/tmp';
  const remoteScript = remoteDir + family.sep + 'vws-exec-' + stamp + ext;
  const remoteLog = remoteDir + family.sep + 'vws-exec-' + stamp + '.log';
  const hostScript = path.join(os.tmpdir(), 'vws-exec-' + stamp + ext);
  const hostLog = path.join(os.tmpdir(), 'vws-exec-' + stamp + '.log');

  // The whole command goes inside a subshell so the redirect covers every
  // segment. Appending `> log 2>&1` directly would bind to the last command of
  // a `a && b` / `a | b` chain and silently drop the rest of the output.
  const body = family.windows
    ? '@echo off\r\n(\r\n' + cmdline + '\r\n) > ' + remoteLog + ' 2>&1\r\n'
    : '#!/bin/sh\n(\n' + cmdline + '\n) > ' + remoteLog + ' 2>&1\n';

  fs.writeFileSync(hostScript, body, 'utf8');
  guestCopyTo(vm, hostScript, remoteScript);

  let r;
  try {
    r = family.windows
      ? vmrunGuestRaw(['runProgramInGuest', vm.vmx, 'C:\\Windows\\System32\\cmd.exe', '/c ' + remoteScript])
      : vmrunGuestRaw(['runProgramInGuest', vm.vmx, '/bin/sh', remoteScript]);
  } finally {
    try { fs.unlinkSync(hostScript); } catch (e) { /* ignore */ }
  }

  let output = '';
  if (guestPathExistsQuiet(vm, remoteLog)) {
    try {
      guestCopyFrom(vm, remoteLog, hostLog);
      output = decodeText(fs.readFileSync(hostLog));
    } catch (e) {
      output = '[could not read guest output: ' + e.message + ']';
    }
    try { fs.unlinkSync(hostLog); } catch (e) { /* ignore */ }
    vmrunGuestRaw(['deleteFileInGuest', vm.vmx, remoteLog]);
  }
  vmrunGuestRaw(['deleteFileInGuest', vm.vmx, remoteScript]);

  const m = /non-zero exit code:\s*(-?\d+)/i.exec(guestError(r));
  const code = m ? Number(m[1]) : (r.code === 0 ? 0 : r.code);
  // A guest command that merely exits non-zero is not a wrapper failure, but a
  // command that never ran is.
  if (!output && code !== 0 && r.code !== 0 && !m) fail(guestError(r));
  return { output: output, code: code };
}

/**
 * Wait until guest operations actually work.
 *
 * checkToolsState can say "running" while every guest call still times out —
 * a wedged guest channel looks exactly like a healthy one. Only a real round
 * trip proves the channel is usable.
 */
function guestReady(vm, budgetMs) {
  // Validate credentials up front. The probe below swallows errors by design
  // (a wedged channel must read as "not ready"), which would otherwise turn
  // "you forgot VMWARE_GUEST_PASS" into a misleading `ready: false`.
  guestCreds();
  const started = Date.now();
  const limit = budgetMs > 0 ? budgetMs : 180000;
  let tools = 'unknown';
  while (Date.now() - started < limit) {
    const r = run(vmrunPath(), ['-T', 'ws', 'checkToolsState', vm.vmx], { timeout: 60000 });
    tools = ((r.out || '') + (r.err || '')).trim();
    if (/^running/i.test(tools)) break;
    sleepMs(2000);
  }
  const running = /^running/i.test(tools);
  const family = guestOsFamily(vm);
  const probe = running && guestPathExistsQuiet(vm, family === 'windows' ? 'C:\\' : '/', 'dir');
  return {
    tools: running ? 'running' : (tools || 'unknown'),
    ready: Boolean(probe),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Parse `vmcli Guest env` output into a map.
 *
 * The format is `KEY=VALUE KEY=VALUE ...` on a single line. Values may contain
 * spaces (PATH, ProgramFiles), so a naive split on whitespace is wrong — split
 * on the boundary where a space is followed by something that looks like a new
 * `KEY=`.
 */
function parseGuestEnv(text) {
  const body = String(text || '').trim();
  if (!body) return {};
  const parts = body.split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?=)/);
  const result = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    result[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return result;
}

/**
 * Run a script body through a chosen interpreter, without runScriptInGuest.
 *
 * The body is uploaded as a temp file and executed as a normal program. The
 * returned text is what runProgramInGuest printed (usually nothing), not the
 * script's own output — use `guest exec` when you need stdout back.
 */
function guestScriptFile(vm, interpreter, script, flags) {
  const family = guestFamilyInfo(vm);
  const stamp = process.pid + '-' + Date.now();
  const ext = family.windows ? '.bat' : '.sh';
  const remote = (family.windows ? 'C:\\Windows\\Temp' : '/tmp') + family.sep + 'vws-script-' + stamp + ext;
  const hostTmp = path.join(os.tmpdir(), 'vws-script-' + stamp + ext);

  const body = family.windows
    ? '@echo off\r\n' + script + '\r\n'
    : '#!/bin/sh\n' + script + '\n';

  fs.writeFileSync(hostTmp, body, 'utf8');
  guestCopyTo(vm, hostTmp, remote);
  try { fs.unlinkSync(hostTmp); } catch (e) { /* ignore */ }

  const a = [vm.vmx];
  if (flags && flags['no-wait']) a.push('-noWait');
  if (flags && flags['active-window']) a.push('-activeWindow');
  if (flags && flags.interactive) a.push('-interactive');
  if (family.windows) {
    // A .bat/.cmd body can only be run by cmd, and launching cmd without /c
    // opens an interactive shell that never returns. The interpreter argument
    // is therefore ignored here; use guest exec with a powershell one-liner if
    // you need another engine.
    a.push('C:\\Windows\\System32\\cmd.exe', '/c ' + remote);
  } else {
    a.push(interpreter, remote);
  }

  try {
    const r = vmrunGuest(['runProgramInGuest'].concat(a));
    return r || 'OK';
  } finally {
    vmrunGuestRaw(['deleteFileInGuest', vm.vmx, remote]);
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
      if (flags.long) {
        // Keep the detailed table available, but as an explicit opt-in.
        out(parseOrRaw(vmcliGuest(vm.vmx, 'Guest', 'ls', [p])));
      } else {
        out(JSON.stringify(guestListNames(vm, p), null, 2));
      }
      return;
    }
    case 'mkdir':
      ensureGuestDir(vm, pos[2]);
      out('created ' + pos[2]);
      return;
    case 'rmdir':
      if (!pos[2]) fail('guest rmdir needs a path.');
      // On Windows vmrun's deleteDirectoryInGuest already removes the contents;
      // on Linux it refuses a non-empty directory, so --recursive is the only
      // reliable way to express "delete the whole tree" across both.
      if (flags.recursive) {
        vmcliGuest(vm.vmx, 'Guest', 'rmdir', [pos[2], '-r']);
      } else {
        const r = vmrunGuestRaw(['deleteDirectoryInGuest', vm.vmx, pos[2]]);
        if (r.code !== 0) {
          fail(guestError(r) + '\n(while removing ' + pos[2] + ')' +
            '\nIf the directory is not empty, add --recursive.');
        }
      }
      out('removed dir ' + pos[2]);
      return;
    case 'rm':
      guestOrDie(vmrunGuestRaw(['deleteFileInGuest', vm.vmx, pos[2]]), 'deleting ' + pos[2]);
      out('removed ' + pos[2]);
      return;
    case 'mv': {
      const a = [pos[2], pos[3]];
      if (flags.overwrite) a.push('-o');
      vmcliGuest(vm.vmx, 'Guest', 'mv', a);
      out('moved ' + pos[2] + ' -> ' + pos[3]);
      return;
    }
    case 'copy-to':
      if (!pos[2] || !pos[3]) fail('guest copy-to needs <hostPath> and <guestPath>.');
      guestCopyTo(vm, pos[2], pos[3]);
      out('copied ' + pos[2] + ' -> ' + pos[3]);
      return;
    case 'copy-from':
      if (!pos[2] || !pos[3]) fail('guest copy-from needs <guestPath> and <hostPath>.');
      guestCopyFrom(vm, pos[2], pos[3]);
      out('copied ' + pos[2] + ' -> ' + pos[3]);
      return;
    case 'put-dir': {
      const hostDir = pos[2];
      const guestDir = pos[3];
      if (!hostDir || !guestDir) fail('guest put-dir needs <hostDir> and <guestDir>.');
      if (!fs.existsSync(hostDir) || !fs.statSync(hostDir).isDirectory()) {
        fail('Not a directory on the host: ' + hostDir);
      }
      const family = guestOsFamily(vm);
      const entries = walkLocalDir(hostDir);
      if (!entries.length) fail('Nothing to copy: ' + hostDir + ' is empty.');
      ensureGuestDir(vm, guestDir);
      let dirs = 1;
      let files = 0;
      for (const e of entries) {
        const target = guestJoin(family, guestDir, e.rel);
        if (e.dir) {
          ensureGuestDir(vm, target);
          dirs++;
        } else {
          guestCopyTo(vm, path.join(hostDir, e.rel), target);
          files++;
          process.stderr.write('  ' + e.rel + '\n');
        }
      }
      out(JSON.stringify({ guestDir: guestDir, dirs: dirs, files: files }, null, 2));
      return;
    }
    case 'get-dir': {
      const guestDir = pos[2];
      const hostDir = pos[3];
      if (!guestDir || !hostDir) fail('guest get-dir needs <guestDir> and <hostDir>.');
      const family = guestOsFamily(vm);
      const sep = family === 'windows' ? '\\' : '/';
      fs.mkdirSync(hostDir, { recursive: true });
      let dirs = 1;
      let files = 0;
      const walk = (guestPath, hostPath, depth) => {
        if (depth > 24) fail('Directory tree too deep under ' + guestPath + ' (loop?)');
        for (const name of guestListNames(vm, guestPath)) {
          const g = guestPath.replace(/[\\/]+$/, '') + sep + name;
          const h = path.join(hostPath, name);
          if (guestPathExistsQuiet(vm, g, 'dir')) {
            fs.mkdirSync(h, { recursive: true });
            dirs++;
            walk(g, h, depth + 1);
          } else {
            guestCopyFrom(vm, g, h);
            files++;
            process.stderr.write('  ' + name + '\n');
          }
        }
      };
      walk(guestDir, hostDir, 0);
      out(JSON.stringify({ hostDir: hostDir, dirs: dirs, files: files }, null, 2));
      return;
    }
    case 'exec': {
      const cmdline = pos.slice(2).join(' ');
      if (!cmdline) fail('guest exec needs a command, e.g. guest exec <vm> dir C:\\\\');
      const res = guestExecCapture(vm, cmdline);
      if (res.output) process.stdout.write(res.output.replace(/\s+$/, '') + '\n');
      if (res.code !== 0) {
        process.stderr.write('[guest exit code ' + res.code + ']\n');
        process.exitCode = res.code;
      }
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
      // vmrun's runScriptInGuest hangs indefinitely against a Windows guest
      // (verified: `runScriptInGuest <vmx> cmd.exe "echo hi"` never returns,
      // and the `cmd.exe /c` form reports "A file was not found"). Ship the
      // script as a file and run it with the requested interpreter instead —
      // the same mechanism guest exec uses, which is reliable on both OSes.
      const interpreter = pos[2];
      const script = pos[3];
      if (!interpreter || script === undefined) {
        fail('guest script needs <interpreter> and <script content>.');
      }
      out(guestScriptFile(vm, interpreter, script, flags));
      return;
    }
    case 'ready': {
      const res = guestReady(vm, cliTimeoutMs);
      out(JSON.stringify(res, null, 2));
      if (!res.ready) {
        process.exitCode = 1;
      }
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
    case 'exists':
    case 'dir-exists': {
      if (!pos[2]) fail('guest ' + sub + ' needs a path.');
      // A query, not an assertion: an absent path is a normal answer, not an error.
      const isDir = sub === 'dir-exists';
      const found = guestPathExists(vm, pos[2], isDir ? 'dir' : 'file');
      if (!found && !isDir && guestPathExistsQuiet(vm, pos[2], 'dir')) {
        // Answering a bare "false" for a directory is technically right but
        // reads like a bug; say which command was actually needed.
        process.stderr.write(pos[2] + ' is a directory — use `guest dir-exists`.\n');
      }
      out(found ? 'true' : 'false');
      return;
    }
    case 'temp': {
      const r = vmrunGuest(['CreateTempfileInGuest', vm.vmx]);
      out(String(r).trim());
      return;
    }
    case 'env': {
      // vmcli prints the environment as one long space-separated `K=V K=V`
      // line, not YAML — feeding it to parseOrRaw produced a single bogus key
      // with the entire environment stuffed into it.
      const raw = vmcliGuest(vm.vmx, 'Guest', 'env', []);
      out(JSON.stringify(parseGuestEnv(raw), null, 2));
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

/**
 * Chipset setters go through the hot-plug path, which only works while the VM
 * is powered off. A running VM answers "Not currently processing an active
 * hot-plug batch", which says nothing about the actual cause.
 */
function requirePoweredOff(vm, action) {
  let state = null;
  try {
    const q = parseOrRaw(vmcli(vm.vmx, 'Power', 'query'));
    state = q && q.PowerState ? String(q.PowerState).toLowerCase() : null;
  } catch (e) { /* unknown state: let the CLI decide */ }
  if (state && state !== 'off') {
    fail('Cannot ' + action + ' while the VM is ' + state + '.\n' +
      'Power it off first:  node vmware.js power stop "' + vm.name + '"\n' +
      '(To edit the .vmx for the next boot instead: config set ' + vm.name + ' memsize <MB>)');
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
      requirePoweredOff(vm, 'change the vCPU count');
      vmcli(vm.vmx, 'Chipset', 'SetVCpuCount', [String(pos[2])]);
      out('vcpu count set to ' + pos[2]);
      return;
    case 'memory':
      requirePoweredOff(vm, 'change memory size');
      vmcli(vm.vmx, 'Chipset', 'SetMemSize', [String(pos[2])]);
      out('memory set to ' + pos[2] + ' MB');
      return;
    case 'cores':
      requirePoweredOff(vm, 'change cores per socket');
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

/**
 * Attach a freshly created .vmdk to the first free SATA slot.
 *
 * vmcli has no "add disk" command; the equivalent is writing the device's
 * fileName + present entries into the .vmx (which vmcli does through
 * ConfigParams SetEntry) and making sure the controller exists.
 *
 * @return the slot label, or null when nothing could be attached
 */
function attachDisk(vm, file) {
  const vmx = vm.vmx;
  let params;
  try {
    params = parseOrRaw(vmcli(vmx, 'ConfigParams', 'query'));
  } catch (e) {
    return null;
  }
  if (!params || typeof params !== 'object') return null;

  // Controllers the VM already has, plus the first one that is absent.
  const controllers = [];
  for (const key of Object.keys(params)) {
    const m = /^(sata|scsi|nvme|ide)(\d+)\.present$/i.exec(key);
    if (m && /true|1/i.test(String(params[key]))) controllers.push(m[1].toLowerCase() + m[2]);
  }
  let controller = controllers[0];
  if (!controller) {
    // `Sata SetPresent` no-ops when the controller isn't in the .vmx yet and
    // still exits 0 — same trap as `Ethernet SetPresent`. Write the config
    // entry directly.
    controller = 'sata0';
    vmcli(vmx, 'ConfigParams', 'SetEntry', [controller + '.present', 'TRUE']);
    vmcli(vmx, 'ConfigParams', 'SetEntry', [controller + '.virtualDev', 'ahci']);
    controllers.push(controller);
  }

  const used = new Set();
  for (const key of Object.keys(params)) {
    const m = /^sata(\d+):(\d+)\.present$/i.exec(key);
    if (m && /true|1/i.test(String(params[key]))) used.add(Number(m[2]));
  }
  const controllerIndex = Number(controller.replace(/\D+/g, ''));
  let slot = 0;
  while (used.has(slot)) slot++;
  const label = 'sata' + controllerIndex + ':' + slot;

  // .vmx device paths must be written the way VMware itself writes them:
  // relative to the .vmx when the disk sits beside it, otherwise an absolute
  // path with backslashes. A forward-slash absolute path is accepted silently
  // but later breaks every disk operation — `Disk Extend` fails with
  // "The filename, directory name, or volume label syntax is incorrect".
  vmcli(vmx, 'ConfigParams', 'SetEntry', [label + '.fileName', vmxRelativePath(vmx, file)]);
  vmcli(vmx, 'Disk', 'SetPresent', [label, 'true']);
  return label;
}

/** Path for a .vmx device entry: basename if colocated, else backslash absolute. */
function vmxRelativePath(vmxPath, targetPath) {
  const vmxDir = path.dirname(path.resolve(normVmx(vmxPath)));
  const abs = path.resolve(normVmx(targetPath));
  if (path.dirname(abs).toLowerCase() === vmxDir.toLowerCase()) return path.basename(abs);
  return abs.replace(/\//g, '\\');
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
      let file = pos[2];
      const size = pos[3];
      if (!file || !size) fail('disk create needs <file.vmdk> and <size>.');
      // vmcli rejects a bare number ("Input Disk Size is not within acceptable
      // limits"), which reads like a permission problem rather than a typo.
      // Don't guess the unit — 512 could be MB or GB.
      if (!/^\d+\s*(MB|GB|KB|TB)$/i.test(size)) {
        fail('disk create needs a unit in <size>: 512MB, 50GB. Got "' + size + '".');
      }
      // vmcli resolves a relative path against the *current directory*, which
      // scatters .vmdk files wherever the shell happened to be. Anchor it to
      // the VM instead, which is what anyone passing just a filename means.
      if (!/^([A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(file)) {
        file = path.join(path.dirname(path.resolve(normVmx(vm.vmx))), file).replace(/\\/g, '/');
      }
      const a = ['-f', file, '-s', size, '-a', String(flags.adapter || 'lsilogic'), '-t', String(flags.type || '0')];
      vmcli(vm.vmx, 'Disk', 'Create', a);
      // vmcli Disk Create only writes the .vmdk — the controller and the device
      // entry have to be added separately or the disk never appears to the guest.
      const attached = flags['no-attach'] ? null : attachDisk(vm, file);
      if (attached) {
        out('created disk ' + file + ' (' + size + ') attached as ' + attached);
      } else {
        out('created disk ' + file + ' (' + size + ') [not attached: --no-attach]');
      }
      return;
    }
    case 'extend':
      vmcli(vm.vmx, 'Disk', 'Extend', [pos[2], pos[3]]);
      out('extended ' + pos[2]);
      return;
    case 'remove': {
      const label = pos[2];
      if (!label) fail('disk remove needs a <label> (see `disk list`).');
      // Read the backing file before the entry disappears, so --delete-file
      // knows what to unlink.
      const params = parseOrRaw(vmcli(vm.vmx, 'ConfigParams', 'query'));
      const rel = params && params[label + '.fileName'];
      vmcli(vm.vmx, 'Disk', 'SetPresent', [label, 'false']);
      vmcli(vm.vmx, 'ConfigParams', 'SetEntry', [label + '.fileName', '']);
      out('detached ' + label);
      if (flags['delete-file'] && rel) {
        const vmxDir = path.dirname(path.resolve(normVmx(vm.vmx)));
        const abs = path.isAbsolute(rel) ? rel : path.join(vmxDir, rel);
        try {
          fs.unlinkSync(abs);
          out('deleted ' + abs);
        } catch (e) {
          process.stderr.write('could not delete ' + abs + ': ' + e.message + '\n');
        }
      }
      return;
    }
    default:
      fail('Unknown disk subcommand: ' + sub + '\n' + HELP.disk);
  }
}

/** Write a boolean config entry; vmcli wants the literal `true` / `false`. */
function setVmxBool(vm, key, value) {
  vmcli(vm.vmx, 'ConfigParams', 'SetEntry', [key, value ? 'true' : 'false']);
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
    case 'set-present': {
      // `Ethernet SetPresent <label> <bool>` silently does nothing when the
      // device label is not already in the .vmx, and reports success anyway.
      // The config entry is the only form that reliably creates the device.
      if (!pos[2] || pos[3] === undefined) fail('nic set-present needs <label> <true|false>.');
      setVmxBool(vm, pos[2] + '.present', bool(pos[3]));
      out('nic present set: ' + pos[2] + ' = ' + (bool(pos[3]) ? 'true' : 'false'));
      return;
    }
    case 'set-connected': {
      if (!pos[2] || pos[3] === undefined) fail('nic set-connected needs <label> <true|false>.');
      setVmxBool(vm, pos[2] + '.startConnected', bool(pos[3]));
      out('nic startConnected set: ' + pos[2] + ' = ' + (bool(pos[3]) ? 'true' : 'false'));
      return;
    }
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
    case 'add': {
      needRest();
      // vmrest rejects `vmnet` for nat / hostonly / bridged with
      // "Redundant parameter" — those names are implied by the type. Only a
      // custom vmnet needs to be named.
      const body = { type: pos[2] };
      if (pos[3] && String(pos[2]).toLowerCase() === 'custom') body.vmnet = pos[3];
      out(JSON.stringify(rest('POST', '/vms/' + encodeURIComponent(restVmId(vm.vmx)) + '/nic', body), null, 2));
      return;
    }
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
    case 'keys': {
      if (!pos[2]) fail('screen keys needs <keystrokes>.');
      // vmcli MKS works on a text console and needs no guest login; vmrun
      // typeKeystrokesInGuest fails with "Insufficient permissions in the host
      // operating system" when no guest session can take input. MKS types the
      // string literally, so translate the tokens people actually write.
      // It accepts CR, TAB and printable text but rejects ESC and friends —
      // those fall through to vmrun.
      const tokenMap = {
        '<enter>': '\r', '<return>': '\r', '<tab>': '\t', '<space>': ' ',
      };
      const seq = String(pos[2]).replace(/<(enter|return|tab|space)>/gi,
        (m) => tokenMap[m.toLowerCase()]);
      const r = run(vmcliPath(), [vm.vmx, 'MKS', 'sendKeySequence', seq]);
      if (r.code === 0) {
        out('keystrokes sent');
        return;
      }
      vmrunGuest(['typeKeystrokesInGuest', vm.vmx, pos[2]]);
      out('keystrokes sent');
      return;
    }
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
    case 'write': {
      // guestEnv / guestVar live in the guest OS, so vmrun demands a guest
      // login for them; runtimeConfig does not. Passing credentials for
      // runtimeConfig too is harmless, so always use the guest form for the
      // two guest scopes and the plain form for runtimeConfig.
      const scope = pos[2];
      const needsGuest = scope === 'guestEnv' || scope === 'guestVar';
      const call = (args) => (needsGuest ? vmrunGuest(args) : vmrun(args));
      if (!scope) fail('var ' + sub + ' needs a scope: runtimeConfig | guestEnv | guestVar.');
      if (!pos[3]) fail('var ' + sub + ' needs a <name>.');
      if (sub === 'read') {
        out(call(['readVariable', vm.vmx, scope, pos[3]]));
      } else {
        if (pos[4] === undefined) fail('var write needs a <value>.');
        call(['writeVariable', vm.vmx, scope, pos[3], pos[4]]);
        out('variable written');
      }
      return;
    }
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
      // vmcli's VMTemplate Deploy accepts exactly one option, -p <vmtx path>.
      // There is no destination or name flag; the deployed VM lands next to the
      // template and takes its name. Reject the old flags loudly rather than
      // passing them through and getting "Invalid/unrecognized argument".
      if (flags.dest || flags.name) {
        fail('template deploy takes no --dest or --name: vmcli only supports -p <template.vmtx>.\n' +
          'The VM is created alongside the template and named after it.\n' +
          'Copy the template first if you need it in another directory.');
      }
      const a = ['-p', pos[1]];
      vmcli(null, 'VMTemplate', 'Deploy', a);
      out('template deployed: ' + pos[1]);
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
  // vmcli's own help advertises numeric guest ids for -g, but the executable
  // only accepts a name enum and rejects `-g 13`. `-c` takes any guestOS name,
  // so use it for everything and keep `-g`'s short enum list out of the way.
  const guest = String(flags.guest || flags.custom || 'other6xlinux-64');
  const a = ['-n', name, '-d', dir, '-c', guest];
  vmcli(null, 'VM', 'Create', a);
  // `VM Create` writes the .vmdk but no controller and no disk entry, exactly
  // like `Disk Create`. Left alone the VM has a disk file it cannot boot from.
  const vmx = path.join(path.resolve(normVmx(dir)), name + '.vmx').replace(/\\/g, '/');
  const vmdk = path.join(path.resolve(normVmx(dir)), name + '.vmdk').replace(/\\/g, '/');
  let attached = null;
  if (fs.existsSync(vmdk)) attached = attachDisk({ vmx: vmx, name: name }, vmdk);
  out('created VM ' + name + ' in ' + dir + (attached ? ' (disk attached as ' + attached + ')' : ''));
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
      credentialsConfigured: !!restCredentials(),
      credentialSource: 'VMWARE_REST_USER / VMWARE_REST_PASSWORD',
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
    case 'nic-create': {
      // Same rule as `nic add`: vmrest only accepts `vmnet` for custom.
      const body = { type: pos[2] };
      if (pos[3] && String(pos[2]).toLowerCase() === 'custom') body.vmnet = pos[3];
      out(JSON.stringify(rest('POST', '/vms/' + encodeURIComponent(vid(pos[1])) + '/nic', body), null, 2));
      return;
    }
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
  argv = extractTimeout(argv);
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

// Only run when invoked directly. `require()` from selftest.js must not execute
// a command, and the unit test needs the helpers below.
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
    process.exit(e && e.vmExit ? e.vmExit : 1);
  }
}

module.exports = {
  main: main,
  redact: redact,
  extractTimeout: extractTimeout,
  parseYaml: parseYaml,
  parseOrRaw: parseOrRaw,
  yamlScalar: yamlScalar,
  normVmx: normVmx,
  resolveVm: resolveVm,
  guestJoin: guestJoin,
  osFamilyOf: osFamilyOf,
  splitArgs: splitArgs,
  parseGuestEnv: parseGuestEnv,
  restCredentials: restCredentials,
  restBase: restBase,
  HELP: HELP,
  get cliTimeoutMs() { return cliTimeoutMs; },
  resetCliTimeout: function () { cliTimeoutMs = null; },
};
