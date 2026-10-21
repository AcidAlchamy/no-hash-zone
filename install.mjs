#!/usr/bin/env node
// Installs No-Hash Zone into Claude Code's user configuration (~/.claude, or $CLAUDE_CONFIG_DIR if set):
//   1. hooks/no-hash-guard.mjs, plus hooks/no-hash-guard.config.json if you don't have one yet
//   2. a PreToolUse entry in settings.json that runs the guard before every shell command
//   3. the policy block from CLAUDE.md at the top of your CLAUDE.md, listing your protected locations
// settings.json and CLAUDE.md are backed up before they change. Run again at any time to update.
//
//   node install.mjs --path "/Volumes/Private" --path "D:\Private"   protect these (added to your config)
//   node install.mjs --matcher "Bash|PowerShell|mcp__desktop-commander__start_process"
//   node install.mjs --dry-run                                        show what would change
//   node install.mjs --uninstall                                      remove the settings entry and the block

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATCHER = 'Bash|PowerShell';
const BEGIN = '<!-- no-hash-zone:begin -->';
const END = '<!-- no-hash-zone:end -->';

function parseArgs(argv) {
  const opts = { paths: [], matcher: null, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--path' && argv[i + 1]) opts.paths.push(argv[++i]);
    else if (arg === '--matcher' && argv[i + 1]) opts.matcher = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option ${arg} (try --help)`);
  }
  return opts;
}

const opts = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
})();
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12)
    .map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const HOOK = join(CLAUDE_DIR, 'hooks', 'no-hash-guard.mjs');
const CONFIG = join(CLAUDE_DIR, 'hooks', 'no-hash-guard.config.json');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const say = text => console.log((opts.dryRun ? '[dry run] ' : '') + text);
const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : null);

function write(file, text) {
  if (opts.dryRun) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function backup(file) {
  if (opts.dryRun || !existsSync(file)) return;
  const copy = `${file}.bak-no-hash-zone-${STAMP}`;
  copyFileSync(file, copy);
  say(`  backup: ${copy}`);
}

function readJson(file, fallback) {
  const text = read(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    console.error(`${file} is not valid JSON (${err.message}). Fix it first; nothing was changed.`);
    process.exit(1);
  }
}

const mentionsGuard = hook => JSON.stringify(hook).includes('no-hash-guard');

// The node on PATH when it is the one running this installer (Homebrew's /opt/homebrew/bin/node survives an
// upgrade; the versioned path behind it does not), else this node's own path.
function stableNode() {
  const self = realpathSync(process.execPath);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile() && realpathSync(candidate) === self) return candidate;
    } catch {
      // not in this directory
    }
  }
  return process.execPath;
}
const NODE = stableNode();

// --- settings.json --------------------------------------------------------------------------------------
function updateSettings(settings) {
  const groups = (settings.hooks ??= {}).PreToolUse ??= [];
  // onFailure "block": if the guard can't run (node moved, file deleted), shell commands stop instead of
  // silently going unchecked.
  const entry = { type: 'command', command: NODE, args: [HOOK], timeout: 10, onFailure: 'block' };
  const existing = groups.find(group => (group.hooks || []).some(mentionsGuard));
  if (existing) {
    existing.hooks = existing.hooks.map(hook => (mentionsGuard(hook) ? entry : hook));
    if (opts.matcher) existing.matcher = opts.matcher;
    return `updated the PreToolUse entry (matcher "${existing.matcher}")`;
  }
  groups.push({ matcher: opts.matcher || DEFAULT_MATCHER, hooks: [entry] });
  return `added a PreToolUse entry (matcher "${opts.matcher || DEFAULT_MATCHER}")`;
}

function removeFromSettings(settings) {
  const groups = settings.hooks?.PreToolUse;
  const ours = group => (group.hooks || []).some(mentionsGuard);
  if (!Array.isArray(groups) || !groups.some(ours)) return false;
  const kept = [];
  for (const group of groups) {
    if (!ours(group)) kept.push(group);
    else if (group.hooks.some(hook => !mentionsGuard(hook))) {
      kept.push({ ...group, hooks: group.hooks.filter(hook => !mentionsGuard(hook)) });
    }
  }
  if (kept.length) settings.hooks.PreToolUse = kept;
  else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return true;
}

// --- CLAUDE.md ------------------------------------------------------------------------------------------
function policyBlock(paths) {
  const source = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
  const block = source.slice(source.indexOf(BEGIN), source.indexOf(END) + END.length);
  const list = paths.length ? paths.map(p => `- \`${p}\``).join('\n') : '- (none listed yet)';
  return block.replace(/(<!-- no-hash-zone:paths:begin -->\n)[\s\S]*?(\n<!-- no-hash-zone:paths:end -->)/,
    `$1${list}$2`);
}

function withBlock(text, block) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const plain = text.replace(/\r\n/g, '\n');
  const start = plain.indexOf(BEGIN);
  const end = plain.indexOf(END);
  const updated = start !== -1 && end > start
    ? plain.slice(0, start) + block + plain.slice(end + END.length)
    : block + (plain.trim() ? '\n\n' + plain : '\n');
  return updated.replace(/\n/g, eol);
}

function withoutBlock(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const plain = text.replace(/\r\n/g, '\n');
  const start = plain.indexOf(BEGIN);
  const end = plain.indexOf(END);
  if (start === -1 || end < start) return null;
  return (plain.slice(0, start) + plain.slice(end + END.length).replace(/^\n+/, '')).replace(/\n/g, eol);
}

// --- run ------------------------------------------------------------------------------------------------
const settings = readJson(SETTINGS, {});

if (opts.uninstall) {
  if (removeFromSettings(settings)) {
    backup(SETTINGS);
    write(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    say(`settings.json: removed the no-hash-guard entry (${SETTINGS})`);
  } else {
    say('settings.json: no no-hash-guard entry found');
  }
  const md = read(CLAUDE_MD);
  const stripped = md === null ? null : withoutBlock(md);
  if (stripped !== null) {
    backup(CLAUDE_MD);
    write(CLAUDE_MD, stripped);
    say(`CLAUDE.md: removed the No-Hash Zone block (${CLAUDE_MD})`);
  } else {
    say('CLAUDE.md: no No-Hash Zone block found');
  }
  say(`Left in place (delete them if you like): ${HOOK} and ${CONFIG}`);
  process.exit(0);
}

console.log(`Installing No-Hash Zone into ${CLAUDE_DIR}`);

// 1. the guard and its config
const hookSource = readFileSync(join(REPO, 'hooks', 'no-hash-guard.mjs'), 'utf8');
const installedHook = read(HOOK);
if (installedHook !== hookSource) {
  backup(HOOK);
  write(HOOK, hookSource);
}
say(`guard: ${HOOK}${installedHook === hookSource ? ' (already current)' : ''}`);

const configExisted = existsSync(CONFIG);
const config = configExisted
  ? readJson(CONFIG, {})
  : { ...JSON.parse(readFileSync(join(REPO, 'hooks', 'no-hash-guard.config.example.json'), 'utf8')),
    ...(opts.paths.length ? { protectedPaths: [] } : {}) };
config.protectedPaths = [...new Set([...(config.protectedPaths || []), ...opts.paths])];
if (!configExisted || opts.paths.length) {
  backup(CONFIG);
  write(CONFIG, JSON.stringify(config, null, 2) + '\n');
}
say(`config: ${CONFIG}${configExisted ? '' : ' (new)'}`);
for (const p of config.protectedPaths) say(`  protected: ${p}`);
if (!configExisted && !opts.paths.length) {
  say('  These are the example locations. Edit the config to list your own, then run this again so CLAUDE.md');
  say('  lists them too (or rerun with --path).');
}

// 2. settings.json
const before = JSON.stringify(settings);
const change = updateSettings(settings);
if (JSON.stringify(settings) !== before) {
  backup(SETTINGS);
  write(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}
say(`settings.json: ${change}, running ${NODE}`);

// 3. CLAUDE.md
const md = read(CLAUDE_MD) ?? '';
const newMd = withBlock(md, policyBlock(config.protectedPaths));
if (newMd !== md) {
  backup(CLAUDE_MD);
  write(CLAUDE_MD, newMd);
}
say(`CLAUDE.md: ${newMd === md ? 'policy block already current' : (md.includes(BEGIN) ? 'updated' : 'added')
  + ' the policy block at the top'} (${CLAUDE_MD})`);

console.log(opts.dryRun
  ? 'Nothing was changed.'
  : 'Done. Start a new Claude Code session: CLAUDE.md is read when a session starts.');
