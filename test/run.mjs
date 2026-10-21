#!/usr/bin/env node
// Feeds every case in cases.json to the guard, with config.json from this folder, and checks its decision.
// The commands are only text handed to the hook: nothing is executed and nothing is hashed.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'hooks', 'no-hash-guard.mjs');
const cases = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

let failed = 0;
for (const c of cases) {
  const command = typeof c.command === 'string' ? c.command.replace('{home}', homedir()) : c.command;
  const input = c.raw ?? JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: c.tool || 'Bash',
    tool_input: command === null ? {} : { command },
    cwd: c.cwd || homedir(),
  });
  const config = c.config === 'missing' ? join(HERE, 'no-such-config.json') : join(HERE, 'config.json');
  const run = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_HASH_GUARD_CONFIG: config },
  });
  const got = run.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  const ok = run.status === 0 && got === c.want;
  if (!ok) failed++;
  const label = c.raw ?? (command === null ? '(no command)' : command);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${got.padEnd(5)} ${c.tool && c.tool !== 'Bash' ? `[${c.tool}] ` : ''}${label}`
    + (c.note ? `  -- ${c.note}` : '') + (run.stderr ? `\n     stderr: ${run.stderr.trim()}` : ''));
}
console.log(failed ? `\n${failed} of ${cases.length} cases FAILED` : `\nall ${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
