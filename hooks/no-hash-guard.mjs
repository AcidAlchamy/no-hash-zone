#!/usr/bin/env node
// no-hash-guard: a Claude Code PreToolUse hook. It refuses shell commands that would hash, checksum or
// fingerprint files in your protected locations, and lets everything else through untouched.
//
// Claude Code hands the pending tool call to this script as JSON on stdin. To refuse, the script prints a
// PreToolUse "deny" decision whose reason Claude reads; to allow, it prints nothing. The protected locations
// come from no-hash-guard.config.json next to this file, or from the file named by NO_HASH_GUARD_CONFIG.
// It fails closed: unreadable input, a missing or broken config, or an internal error refuses the command.
// Node 18 or newer, no dependencies.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = process.env.NO_HASH_GUARD_CONFIG
  || join(dirname(fileURLToPath(import.meta.url)), 'no-hash-guard.config.json');

const DEFAULT_REASON = 'No-hash zone: this command would hash, checksum or fingerprint files in a protected '
  + 'location (rsync and content-based dedup included). Work from metadata instead (names, sizes, dates), '
  + 'or ask the owner.';

// Commands, tools and APIs that derive a value from file contents. Matched against the lower-cased command
// with forward slashes, and refused only when the same command (or its working directory) touches a
// protected location.
const HASH_OPERATIONS = [
  // digest and checksum tools (macOS also ships md5, sha1, sha256 ... without the "sum")
  /\b(?:md2|md4|md5|md6|sha1|sha224|sha256|sha384|sha512|sha3-?(?:224|256|384|512)|b2|b3)sum\b/,
  /\bmd5\b/,
  /\b(?:shasum|cksum|rhash|xxh(?:32|64|128|3)?sum|hashdeep|md5deep|sha1deep|sha256deep|sha512deep|ssdeep|sdhash|tlsh|fciv)\b/,
  /\bopenssl\s+(?:dgst|md5|sha1|sha224|sha256|sha384|sha512|sha3-?(?:224|256|384|512))\b/,
  /\bcertutil\b[^\n]*[-/]hashfile\b/,
  // duplicate finders, and copy / sync / backup tools that checksum or chunk content
  /\b(?:fdupes|jdupes|rdfind|dupeguru|czkawka(?:_cli)?|rsync|rclone|restic|borg|kopia|duplicacy|bup)\b/,
  /\bgit\b[^|;&\n]*\b(?:add|commit|hash-object|stash|annex|lfs)\b/,
  // media tools: ffmpeg's hash muxers, ImageMagick's %# signature, ExifTool's image-data hash
  /\b(?:framemd5|framecrc|framehash|streamhash)\b/,
  /\bffmpeg\b[^|;&\n]*-f\s+(?:md5|hash|crc)\b/,
  /\b(?:identify|magick|convert)\b[^|;&\n]*%#/,
  /\b(?:imagedatahash|imagehashtype)\b/,
  // PowerShell / .NET
  /\b(?:get-filehash|computehash|hashalgorithm|filehash|checksums?|check[-_]?sum|file[-_]?fingerprint|content[-_]?fingerprint)\b/,
  // libraries and calls
  /\b(?:hashlib|xxhash|blake3|blake2[bs]?|murmurhash3?|mmh3|cityhash|farmhash|simhash|minhash|imagehash|phash|dhash|ahash|whash|kangarootwelve|ripemd(?:160)?|whirlpool|streebog)\b/,
  /\b(?:zlib|binascii)\s*\.\s*crc32\s*\(/,
  /\b(?:createhash|createhmac|computehash|messagedigest|subtle\s*\.\s*digest)\b/,
  /\b(?:md5|sha\d{1,3}|sha3_?\d{3}|blake2[bs]?)\s*[\])]?\s*(?:\.|::)\s*(?:create|new|digest|hexdigest)\s*\(/,
  /\b(?:crc(?:8|16|32|32c|64)|adler[-_]?32|fletcher(?:16|32|64)|fnv[-_]?1a?|sha[-_]?\d+|hmac)\b/,
  // the techniques by name
  /\b(?:merkle[\s_-](?:tree|root)|content[-_]?address(?:able|ed)?|content[-_]?defined[-_]?chunk(?:ing)?|rolling[-_]?(?:hash|checksum))\b/,
  /\b(?:dedup(?:e|lication)?|fingerprint(?:ing)?|integrity[-_]?scan|verify[-_]?(?:checksum|hash))\b/,
];

class Deny {
  constructor(reason) { this.reason = reason; }
}

const norm = value => String(value ?? '').replace(/\\/g, '/').toLowerCase();
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every spelling a shell might use for one configured location.
function spellings(location) {
  const path = norm(location).trim().replace(/(.)\/+$/, '$1');
  if (!path) return [];
  const out = new Set([path]);
  const home = norm(homedir());
  if (path === '~' || path.startsWith('~/')) {
    for (const h of [home, '$home', '${home}', '%userprofile%', '$env:userprofile']) out.add(h + path.slice(1));
  } else if (home && (path === home || path.startsWith(home + '/'))) {
    out.add('~' + path.slice(home.length));
    out.add('$home' + path.slice(home.length));
  }
  const drive = /^([a-z]):(\/.*)?$/.exec(path);
  if (drive) {
    const rest = drive[2] || '';
    out.add(`/${drive[1]}${rest}`);          // Git Bash / MSYS
    out.add(`/mnt/${drive[1]}${rest}`);      // WSL
    out.add(`/cygdrive/${drive[1]}${rest}`); // Cygwin
  }
  return [...out];
}

// A location matches as a whole path: "/mnt/private" matches "/mnt/private/a.mov" and "/mnt/private-2",
// not "/mnt/privateer" or "/data/mnt/private".
const locationPattern = spelling => new RegExp('(?:^|[^a-z0-9_.-])' + escapeRe(spelling) + '(?![a-z0-9_])');

function loadConfig() {
  let text;
  try {
    text = readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    throw new Deny(`no-hash-guard: cannot read its config ${CONFIG_FILE} (${err.code || err.message}). Create it `
      + 'from no-hash-guard.config.example.json; until then shell commands are refused.');
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Deny(`no-hash-guard: ${CONFIG_FILE} is not valid JSON (${err.message}); shell commands are refused `
      + 'until it is fixed.');
  }
  const strings = key => (Array.isArray(config[key]) ? config[key] : [])
    .filter(item => typeof item === 'string' && item.trim());
  const patterns = key => strings(key).map(source => {
    try {
      return new RegExp(source, 'i');
    } catch (err) {
      throw new Deny(`no-hash-guard: bad pattern in "${key}" of ${CONFIG_FILE} (${err.message}); shell commands `
        + 'are refused until it is fixed.');
    }
  });
  return {
    locations: strings('protectedPaths').flatMap(spellings).map(locationPattern),
    blocked: patterns('blockedPatterns'),
    extra: patterns('extraHashPatterns'),
    reason: typeof config.reason === 'string' && config.reason.trim() ? config.reason.trim() : DEFAULT_REASON,
  };
}

function check(input) {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    throw new Deny('no-hash-guard: unreadable hook input; refused as a precaution.');
  }
  const command = event?.tool_input?.command;
  if (typeof command !== 'string') {
    throw new Deny('no-hash-guard: no command to check in this tool call; refused as a precaution.');
  }
  const config = loadConfig();
  const cmd = norm(command);
  if (config.blocked.some(re => re.test(cmd))) throw new Deny(config.reason);
  const cwd = norm(event.cwd);
  const touchesProtected = config.locations.some(re => re.test(cmd) || (cwd && re.test(cwd)));
  if (touchesProtected && [...HASH_OPERATIONS, ...config.extra].some(re => re.test(cmd))) {
    throw new Deny(config.reason);
  }
}

let reason = null;
try {
  check(readFileSync(0, 'utf8'));
} catch (err) {
  reason = err instanceof Deny ? err.reason : `no-hash-guard: internal error (${err?.message}); refused as a precaution.`;
}
if (reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}
