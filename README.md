# No-Hash Zone

**Keep AI coding agents from hashing, checksumming or fingerprinting your private files.**

No-Hash Zone is a policy and a guard for [Claude Code](https://code.claude.com/docs/en/overview). You
list the folders, drives and network shares that hold private material. The policy tells the agent those places
are a no-hashing zone, and the guard, a small `PreToolUse` hook, stops any shell command that would break the rule
before it runs. It works on macOS, Linux and Windows and needs nothing but Node.js.

```text
Claude wants to run:  rsync -a /Volumes/Private/shoot-0412/ /Volumes/Backup/shoot-0412/

The guard answers:    deny
                      "No-hash zone: this command would hash, checksum or fingerprint files in a
                      protected location (rsync and content-based dedup included). Work from metadata
                      instead (names, sizes, dates), or ask the owner."

Claude Code doesn't run the command, and Claude reads the reason.
```

## Why a hash is a leak

Ask an agent to *"copy these clips to the backup drive and make sure nothing got corrupted"* and the obvious move
is `sha256sum` on both sides. *"Find the duplicates in this folder"* becomes `fdupes`. *"Keep it in sync"* becomes
`rsync`. A quick indexing script grows a `hashlib` cache key. None of that looks like a privacy problem, but each
one turns a private file into a fingerprint, and a fingerprint travels:

- **It identifies the exact file.** Anyone who holds the same file, or a list of hashes, can tell you have it.
  Hash lists are how known files are matched across systems.
- **It links copies.** The same value on two machines, two drives or two cloud accounts ties them together.
- **It outlives the task.** The value lands in terminal output, session transcripts, logs and memory files, and
  it goes to the model provider as part of the conversation.
- **Perceptual hashes go further.** pHash, dHash and their relatives still match a photo or a video frame after
  it has been resized, re-encoded or cropped.

The agent never uploaded the file, yet something derived from its contents left the folder. For most code that
doesn't matter. For private media it does.

## Who it is for

Anyone who lets an AI agent work on a machine that also holds material they must not fingerprint or share:

- unreleased film, TV and game footage, and the assets behind it;
- client photo and video shoots, portrait and wedding archives;
- interviews, field recordings and source material;
- legal, medical, HR and financial scans;
- anything under an NDA, a contract or a data-handling agreement that rules out derived identifiers.

With No-Hash Zone in place the agent still copies, moves, lists, sorts and organizes those files. It checks a
copy by names, counts and sizes, finds likely duplicates by name and size, and builds indexes from metadata. When
a task really needs a content comparison, it stops and asks you instead of hashing quietly.

## What's in the box

| Layer | File | What it does |
|---|---|---|
| **Policy** | [`CLAUDE.md`](CLAUDE.md) | Tells Claude the rules: which places are protected; what counts as hashing (every algorithm, checksum and fingerprint, under any name, done directly or delegated); what is still allowed (names, sizes, dates); and what to do when a task seems to need a hash: stop, say why, offer a metadata-only way, never fall back. |
| **Guard** | [`hooks/no-hash-guard.mjs`](hooks/no-hash-guard.mjs) | Runs before every shell command Claude Code is about to run. If the command touches a protected place **and** uses a hashing operation, Claude Code refuses it and Claude reads why. Anything else passes untouched. |
| **Installer** | [`install.mjs`](install.mjs) | Puts both in place for your user, on any OS, and takes them out again. |

The two layers cover each other. The policy handles what no pattern can: judgement, delegation, the tool nobody
listed. The guard handles the moment an instruction gets lost in a long session.

## How the guard works

Claude Code runs the guard as a [`PreToolUse` hook](https://code.claude.com/docs/en/hooks): before a
`Bash` or `PowerShell` tool call runs, it hands the call to the script as JSON on stdin.

1. **Normalize.** The command is lower-cased and backslashes become forward slashes, so `D:\Private`,
   `d:/private` and `D:/PRIVATE` all read the same.
2. **Blocked patterns.** A command matching one of your `blockedPatterns` (say, a script you know hashes
   everything) is refused outright.
3. **Protected location?** Does the command mention a protected location, or run with its working directory
   inside one?
4. **Hashing operation?** Does it use a tool, library call or technique that derives a value from file contents?
5. **Decide.** Both yes: the script prints a `deny` decision with a reason, Claude Code doesn't run the command,
   and Claude reads the reason. Otherwise the script prints nothing and the command runs as usual.

Each location is matched in every spelling a shell might use: forward or back slashes, any letter case, `~` and
`$HOME`, and for a Windows drive path the Git Bash (`/d/Private`), WSL (`/mnt/d/Private`) and Cygwin forms. A
share such as `\\nas\private` also matches `//nas/private` and `smb://nas/private`. Matching is by whole path:
`/mnt/private` covers `/mnt/private/a.mov`, not `/mnt/privateer` or `/data/mnt/private`.

The guard **fails closed**. Unreadable input, a missing or broken config file, or an internal error refuses the
command, with a message that says how to fix it. The installer also registers the hook with `onFailure: "block"`,
so if the guard can't start at all (Node moved, the file deleted), shell commands stop rather than run
unchecked.

It has no dependencies, makes no network calls and writes nothing. It is about 150 lines you can read in a few
minutes.

### What it recognizes

The full list is in [`hooks/no-hash-guard.mjs`](hooks/no-hash-guard.mjs). In short:

- **Digest and checksum tools:** `md5` / `md5sum`, `sha1sum` … `sha512sum`, macOS `sha256` and friends,
  `shasum`, `b2sum`, `b3sum`, `cksum`, `xxhsum`, `openssl dgst`, `rhash`, `hashdeep`, `ssdeep`.
- **Windows:** `Get-FileHash`, `certutil -hashfile`, .NET `HashAlgorithm` / `ComputeHash`.
- **Code:** Python `hashlib` / `zlib.crc32`, Node `crypto.createHash` / `subtle.digest`, Java `MessageDigest`,
  xxHash, BLAKE3, MurmurHash and other hashing libraries.
- **Duplicate finders:** `fdupes`, `jdupes`, `rdfind`, dupeGuru, Czkawka.
- **Copy, sync, backup and versioning tools that checksum or chunk content:** `rsync`, `rclone`, `restic`,
  `borg`, `kopia`, `duplicacy`, `bup`, `git add` / `commit` / `annex` / `lfs`.
- **Media tools:** ffmpeg's `md5`, `framemd5`, `framehash` and `streamhash` outputs, ImageMagick's `%#` image
  signature, ExifTool's image-data hash, perceptual-hash libraries (`imagehash`, pHash, dHash, aHash).
- **The techniques by name:** dedup, fingerprint, Merkle tree, content-addressed, rolling hash, CRC, HMAC.

### What it allows

`ls`, `dir`, `stat`, `du`, `find` by name, `cp`, `mv`, `robocopy`, `Get-ChildItem`, opening and editing files,
anything that works from names, sizes and dates, and any hashing outside the protected locations (checking a
download in `~/Downloads` is fine).

## Install

You need Claude Code and Node.js 18 or newer (`node --version`).

**macOS / Linux**

```bash
git clone https://github.com/AcidAlchamy/no-hash-zone.git
cd no-hash-zone
node install.mjs --path "/Volumes/Private" --path "$HOME/Clients"
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/AcidAlchamy/no-hash-zone.git
cd no-hash-zone
node install.mjs --path "D:\Private" --path "\\nas\clients"
```

The installer works in your Claude Code user folder (`~/.claude`, on Windows `%USERPROFILE%\.claude`, or
`$CLAUDE_CONFIG_DIR` if you set it). It:

1. copies the guard to `hooks/no-hash-guard.mjs` and writes your locations to `hooks/no-hash-guard.config.json`
   (an existing config is kept, and `--path` adds to it);
2. adds one `PreToolUse` entry to `settings.json` and leaves your other settings and hooks alone;
3. puts the policy block at the top of `CLAUDE.md`, listing your protected locations, above anything already
   there.

`settings.json` and `CLAUDE.md` are backed up (`*.bak-no-hash-zone-<time>`) before they change. Run it again any
time to update; `--dry-run` shows what it would do, `--uninstall` takes the settings entry and the policy block
out again. Then **start a new Claude Code session**: `CLAUDE.md` is read when a session starts.

### Manual install

1. Copy `hooks/no-hash-guard.mjs` into `~/.claude/hooks/` (Windows: `%USERPROFILE%\.claude\hooks\`).
2. Copy `hooks/no-hash-guard.config.example.json` next to it as `no-hash-guard.config.json` and list your
   locations.
3. Merge this into `~/.claude/settings.json`, with the absolute paths of your `node` (`which node`, on Windows
   `where node`) and of the guard. Apps started from the Dock or the Start menu don't always see your shell's
   `PATH`, so a bare `node` may not be found.

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash|PowerShell",
           "hooks": [
             {
               "type": "command",
               "command": "/opt/homebrew/bin/node",
               "args": ["/Users/you/.claude/hooks/no-hash-guard.mjs"],
               "timeout": 10,
               "onFailure": "block"
             }
           ]
         }
       ]
     }
   }
   ```

   On Windows: `"command": "C:\\Program Files\\nodejs\\node.exe"` and
   `"args": ["C:\\Users\\you\\.claude\\hooks\\no-hash-guard.mjs"]`.
4. Paste the block between the `no-hash-zone` markers in [`CLAUDE.md`](CLAUDE.md) at the top of your
   `~/.claude/CLAUDE.md`, and list the same locations under *Protected locations*.

## Configure

`no-hash-guard.config.json` sits next to the guard (or wherever `NO_HASH_GUARD_CONFIG` points):

```json
{
  "protectedPaths": ["/Volumes/Private", "/mnt/private", "D:\\Private", "\\\\nas\\private", "~/Clients"],
  "blockedPatterns": ["(?:^|[\\s/'\"`])hash-everything\\.sh\\b"],
  "extraHashPatterns": ["\\bmyhasher\\b"],
  "reason": "Optional: your own refusal message."
}
```

| Key | Meaning |
|---|---|
| `protectedPaths` | Folders, drives, mount points and shares to protect, with everything under them. `~` means your home folder. |
| `blockedPatterns` | Regular expressions for commands that are always refused, wherever they point. |
| `extraHashPatterns` | Regular expressions for more hashing tools; refused together with a protected location. |
| `reason` | The message Claude reads when a command is refused. |

Patterns are matched case-insensitively against the command with backslashes turned into forward slashes. When you
change `protectedPaths`, run the installer again (or edit the list in `CLAUDE.md`) so the policy and the guard name
the same places.

**Other tools that run commands.** If an MCP server lets Claude run shell commands, add that tool's name to the
matcher, for example `node install.mjs --matcher "Bash|PowerShell|mcp__desktop-commander__start_process"`. Only
do this for tools whose input has a `command` field: the guard refuses calls it can't read.

**Keep the agent out entirely.** The guard allows reading and listing on purpose. To stop Claude from reading a
location at all, add `Read` deny rules to `settings.json` as well, for example
`"permissions": { "deny": ["Read(//Volumes/Private/**)"] }` (on Windows, `D:\Private` is written
`Read(//d/Private/**)`).

## Test

```bash
node test/run.mjs
```

This hands 39 commands to the guard, under the sample config in `test/config.json`, and checks each decision. The
commands are only text: nothing is executed and nothing is hashed. The suite passes on macOS, Linux and Windows.

## Limits

No-Hash Zone is a seatbelt, not a vault. Know where it stops:

- **It reads the command line, not what the command does.** `python index.py` passes even if `index.py` hashes
  everything it touches, unless you add the script to `blockedPatterns`. The policy still forbids it; the guard
  can't see it.
- **It knows the tools it lists.** A hashing tool it has never heard of gets through until you add it to
  `extraHashPatterns`.
- **It guards the agent's shell commands only:** not your own terminal, not other apps (backup clients, photo
  libraries, cloud sync), and not Claude's built-in file tools, which read and write but don't hash.
- **It errs on the side of the files.** A harmless command that names a protected place and a hashing word in the
  same line, like `grep checksum /mnt/private/notes.txt`, is refused too.
- **For hard isolation, use the operating system:** file permissions, a separate user account, an encrypted
  volume that stays locked, or Claude Code's sandbox.

## Files

```text
CLAUDE.md                                the policy block (macOS, Linux, Windows)
hooks/no-hash-guard.mjs                  the guard
hooks/no-hash-guard.config.example.json  a starting config
install.mjs                              install, update, uninstall
test/run.mjs, cases.json, config.json    the test suite
```

## License

[Apache-2.0](LICENSE)
