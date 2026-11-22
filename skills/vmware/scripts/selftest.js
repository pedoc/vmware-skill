#!/usr/bin/env node
'use strict';
/**
 * Offline self-test. No VMware install and no VM required.
 *
 * Covers the parts that broke in practice and are cheap to pin here:
 *   - credential masking in printed command lines
 *   - --timeout parsing (including the `--` escape)
 *   - YAML subset parsing
 *   - inventory / vmx path handling
 *   - help output listing the guest commands we added
 *
 * Run: node skills/vmware/scripts/selftest.js   (or `npm test`)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, 'vmware.js');

let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    fn();
    passes++;
    process.stdout.write('  ok   ' + name + '\n');
  } catch (e) {
    failures++;
    process.stdout.write('  FAIL ' + name + '\n       ' + (e && e.message) + '\n');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ', got ' + a);
}

// vmware.js guards main() behind `require.main === module`, so requiring it
// here is safe and gives us the helpers directly.
let I;
try {
  I = require(SRC);
} catch (e) {
  process.stdout.write('FATAL: could not load vmware.js internals: ' + e.message + '\n');
  process.exit(1);
}

process.stdout.write('credential masking\n');
check('masks -gp value', () => {
  const out = I.redact(['-T', 'ws', '-gu', 'admin', '-gp', 'hunter2', 'start', 'x.vmx']);
  assert(!out.includes('hunter2'), 'password leaked: ' + out);
  assert(out.includes('-gp ***'), 'mask not applied: ' + out);
});
check('masks every -gp occurrence', () => {
  const out = I.redact(['-gp', 'a', 'x', '-gp', 'b']);
  assert(!out.includes(' a') && !out.includes(' b'), 'leak: ' + out);
  assertEqual(out.split('***').length - 1, 2);
});
check('leaves non-secret flags intact', () => {
  const out = I.redact(['-gu', 'admin', 'runProgramInGuest', 'vm.vmx']);
  assert(out.includes('admin') && out.includes('runProgramInGuest'));
});

process.stdout.write('--timeout parsing\n');
check('consumes --timeout N and records the value', () => {
  I.resetCliTimeout();
  const r = I.extractTimeout(['guest', 'exec', 'vm', 'dir', '--timeout', '600']);
  assertEqual(r, ['guest', 'exec', 'vm', 'dir']);
  assertEqual(I.cliTimeoutMs, 600000);
});
check('accepts --timeout=N form', () => {
  I.resetCliTimeout();
  const r = I.extractTimeout(['a', '--timeout=30', 'b']);
  assertEqual(r, ['a', 'b']);
  assertEqual(I.cliTimeoutMs, 30000);
});
check('--timeout 0 means no limit', () => {
  I.resetCliTimeout();
  I.extractTimeout(['--timeout', '0']);
  assertEqual(I.cliTimeoutMs, 0);
});
check('stops at -- so guest args survive', () => {
  const r = I.extractTimeout(['guest', 'exec', 'vm', '--', 'slowtool', '--timeout', '5']);
  assertEqual(r, ['guest', 'exec', 'vm', '--', 'slowtool', '--timeout', '5']);
});
check('rejects a non-numeric value', () => {
  let threw = false;
  try { I.extractTimeout(['--timeout', 'soon']); } catch (e) { threw = true; }
  assert(threw, 'expected a parse error');
});
check('rejects a missing value', () => {
  let threw = false;
  try { I.extractTimeout(['--timeout']); } catch (e) { threw = true; }
  assert(threw, 'expected a parse error');
});

process.stdout.write('flag parsing\n');
check('value flags consume the next token', () => {
  const r = I.splitArgs(['vmnew', 'n', 'd', '--guest', '64']);
  assertEqual(r.pos, ['vmnew', 'n', 'd']);
  assertEqual(r.flags.guest, '64');
});
check('--flag=value still works', () => {
  const r = I.splitArgs(['x', '--desc=a b']);
  assertEqual(r.flags.desc, 'a b');
});
check('boolean flags stay boolean', () => {
  const r = I.splitArgs(['--hard', '--nogui', 'vm']);
  assertEqual(r.flags.hard, true);
  assertEqual(r.flags.nogui, true);
  assertEqual(r.pos, ['vm']);
});
check('boolean flag does not eat a following positional', () => {
  const r = I.splitArgs(['power', 'stop', 'vm', '--hard']);
  assertEqual(r.pos, ['power', 'stop', 'vm']);
  assertEqual(r.flags.hard, true);
});
check('--memory is boolean when no number follows', () => {
  const r = I.splitArgs(['snapshot', 'take', 'vm', 'name', '--memory']);
  assertEqual(r.flags.memory, true);
  assertEqual(r.pos, ['snapshot', 'take', 'vm', 'name']);
});
check('--memory takes a number when one follows', () => {
  const r = I.splitArgs(['rest', 'vm-update', 'id', '--memory', '4096']);
  assertEqual(r.flags.memory, '4096');
  assertEqual(r.pos, ['rest', 'vm-update', 'id']);
});
check('value flag at end of args stays boolean', () => {
  const r = I.splitArgs(['x', '--desc']);
  assertEqual(r.flags.desc, true);
});
check('-- stops flag parsing', () => {
  const r = I.splitArgs(['guest', 'exec', 'vm', '--', '--weird', 'arg']);
  assertEqual(r.pos, ['guest', 'exec', 'vm', '--weird', 'arg']);
});

process.stdout.write('YAML subset parsing\n');
check('parses nested maps', () => {
  const v = I.parseYaml('outer:\n  inner: 1\n  flag: true\n');
  assertEqual(v, { outer: { inner: 1, flag: true } });
});
check('parses scalar lists', () => {
  const v = I.parseYaml('items:\n  - one\n  - two\n');
  assertEqual(v, { items: ['one', 'two'] });
});
check('keeps prose instead of mangling it', () => {
  const raw = 'The file does not exist.';
  assertEqual(I.parseOrRaw(raw), raw);
});
check('quoted scalars lose their quotes', () => {
  assertEqual(I.yamlScalar("'a b'"), 'a b');
});
check('numbers become numbers', () => {
  assertEqual(I.yamlScalar('42'), 42);
  assertEqual(I.yamlScalar('1.5'), 1.5);
});

process.stdout.write('.vmx path handling\n');
check('normalizes backslashes', () => {
  assertEqual(I.normVmx('C:\\VMs\\a b\\x.vmx'), 'C:/VMs/a b/x.vmx');
});
check('leaves forward slashes alone', () => {
  assertEqual(I.normVmx('K:/VMs/x.vmx'), 'K:/VMs/x.vmx');
});

process.stdout.write('guest env parsing\n');
check('splits KEY=VALUE pairs on boundaries, not plain whitespace', () => {
  const parsed = I.parseGuestEnv(
    'OS=Windows_NT Path=C:\\Windows;C:\\Windows\\System32 USERNAME=Administrator'
  );
  assertEqual(parsed.OS, 'Windows_NT');
  assertEqual(parsed.Path, 'C:\\Windows;C:\\Windows\\System32');
  assertEqual(parsed.USERNAME, 'Administrator');
});
check('keeps spaces inside values', () => {
  const parsed = I.parseGuestEnv('ProgramFiles=C:\\Program Files COMMON=x');
  assertEqual(parsed.ProgramFiles, 'C:\\Program Files');
  assertEqual(parsed.COMMON, 'x');
});
check('handles keys with parentheses', () => {
  const parsed = I.parseGuestEnv('ProgramFiles(x86)=C:\\Program Files (x86) PUBLIC=C:\\Users\\Public');
  assertEqual(parsed['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
  assertEqual(parsed.PUBLIC, 'C:\\Users\\Public');
});
check('empty input yields an empty map', () => {
  assertEqual(I.parseGuestEnv(''), {});
});

process.stdout.write('guest OS family detection\n');
check('windows guests', () => {
  for (const id of ['windows8srv-64', 'windows9-64', 'winNetStandardGuest', 'WINDOWS10-64']) {
    assertEqual(I.osFamilyOf(id), 'windows', id);
  }
});
check('linux guests', () => {
  for (const id of ['rockylinux-64', 'ubuntu-64', 'centos7-64', 'debian11-64', 'other-64']) {
    assertEqual(I.osFamilyOf(id), 'linux', id);
  }
});
check('unset falls back to linux', () => {
  assertEqual(I.osFamilyOf(''), 'linux');
  assertEqual(I.osFamilyOf(undefined), 'linux');
});

process.stdout.write('guest path joining\n');
check('windows uses backslash', () => {
  assertEqual(I.guestJoin('windows', 'C:\\Temp', 'sub/a.txt'), 'C:\\Temp\\sub\\a.txt');
});
check('linux uses slash', () => {
  assertEqual(I.guestJoin('linux', '/tmp', 'sub/a.txt'), '/tmp/sub/a.txt');
});
check('trailing separators do not double up', () => {
  assertEqual(I.guestJoin('windows', 'C:\\Temp\\', 'a.txt'), 'C:\\Temp\\a.txt');
  assertEqual(I.guestJoin('linux', '/tmp/', 'a.txt'), '/tmp/a.txt');
});

process.stdout.write('help surface\n');
check('guest help lists the commands added for reliability', () => {
  const h = I.HELP.guest;
  for (const cmd of ['exec', 'put-dir', 'get-dir', 'ready', 'dir-exists']) {
    assert(h.includes(cmd), 'guest help is missing ' + cmd);
  }
});
check('guest help documents exists as a query', () => {
  assert(/exit 0 either way/.test(I.HELP.guest), 'exists semantics not documented');
});
check('chipset help warns about power state', () => {
  assert(/powered off/.test(I.HELP.chipset), 'chipset power requirement not documented');
});

process.stdout.write('\n' + passes + ' passed, ' + failures + ' failed\n');
process.exit(failures ? 1 : 0);
