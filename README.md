# fslab – real-shell folder-structure exercises

`fslab.py` is an interactive shell that hands out a **random** exercise: a target
folder structure the student must build inside a sandbox directory with the real
Linux commands. It is not a simulated terminal: `ls`, `cp`, `mv`, `rm`, `rmdir`,
`mkdir`, `touch` and `tree` are the actual programs on the machine. fslab only
sits in between to limit the command set, keep everything inside the lab
directory, and enforce the exercise rules.

Commands available to the student: `ls pwd cd cp mv touch mkdir rm rmdir tree`
plus the lab commands `task check hint help reset new clear exit`.

## Start

```bash
python3 fslab.py                 # new exercise (or resume the saved one) in ~/linux-lab
python3 fslab.py --new           # discard the saved exercise, start a fresh random one
python3 fslab.py --seed 4242     # reproducible: everyone with seed 4242 gets the same task
python3 fslab.py --level 1       # 1 = small, 2 = default, 3 = deeper/larger
python3 fslab.py --root /tmp/lab # use another lab directory
```

Only Python 3 is needed. `tree` is used when installed; otherwise a built-in
look-alike is used and the student is told how to install the real one.

## What an exercise looks like

```
  work/
  ├── api/                ◆ create it with an ABSOLUTE path
  │   ├── notes.txt       ★ no mkdir/touch → copy or move it from ~/stock/notes.txt
  │   ├── schema.sql      ◆ create it with a RELATIVE path
  │   └── tests/
  ├── build/              (already there)
  ├── images/             ★ no mkdir/touch → copy or move it from ~/work/images_backup
  │   └── data.csv        (comes along: ~/work/images_backup/data.csv)
  └── src/                (already there)

Remove from ~/work:
  ~/work/src/trash/      empty directory  rmdir only - no rm!
  ~/work/src/old.log     file
  ~/work/src/leftovers/  directory with stuff inside
```

The lab directory (`~` in the prompt) contains:

- `work/` – must end up looking exactly like the target: nothing more, nothing less.
- `stock/` – materials to copy or move from; its final state does not matter.
- `.lab/` – the exercise spec, the student's state and a full command log
  (`history.log`) for the teacher. Students cannot touch it.

## The rules and how they are enforced

| Rule | Enforcement |
|---|---|
| ★ items may not be created with `mkdir`/`touch` | the command is refused; the `check` also verifies that the file is the original (each one carries a unique ID), so copying some other file does not pass either |
| ◆ items must be created/removed with an absolute or relative path | the argument that creates/removes the item is inspected; `~/...` counts as absolute |
| "rmdir only" directories may not be removed with `rm` (or moved away) | refused, also when they would disappear through a recursive `rm` of a parent |
| only the listed commands, no pipes/redirection/chaining | refused (wildcards do work) |
| stay inside the lab directory | any path resolving outside the lab is refused; `cd` cannot leave it |

Everything else is left to the student: `cp` versus `mv`, the order of the
steps, working from any directory, `mkdir -p`, wildcards, and so on. A refused
command is never executed; rule violations are counted and shown by `check`,
so a teacher can decide whether to accept a solution with violations.

`check` lists what is missing, what should not be there, items of the wrong kind
and ★ items that were recreated instead of copied/moved. `hint` points at one
open item without giving the command.

## In the browser (web version)

`web/` wraps the same `fslab.py` in a web app: every student gets their own
fslab process in a real pseudo-terminal, shown in the browser with xterm.js.
The commands are still the real binaries, so run it in the provided container.

```bash
docker compose up --build          # http://localhost:8080
# or without Docker:
pip install -r web/requirements.txt
FSLAB_TEACHER_KEY=secret python3 web/server.py
```

- Students open the link, enter their name and get a lab. The lab is tied to
  the browser (localStorage), so a refresh or `exit` resumes where they were.
- Share `http://host:8080/?seed=4242` to give everyone that exercise, or
  `?level=3` for a bigger one. `?fresh=1` forces a brand-new student session.
- The header buttons (Task, Hint, Tree, Check, New) just type the command for
  the student; the chips show commands, violations and solved state live.
- Teacher dashboard: `http://host:8080/teacher?key=<FSLAB_TEACHER_KEY>` lists
  every student with exercise, commands, violations, solved status, who is
  online, and a link to their full command log.
- Settings via environment: `FSLAB_TEACHER_KEY`, `FSLAB_LEVEL` (default level),
  `FSLAB_SEED` (same exercise for everyone), `FSLAB_LABS` (where the labs live),
  `FSLAB_PORT`.
- Each student's lab is a directory under `FSLAB_LABS/<session id>/`; it holds
  the same `.lab/history.log` and `.lab/state.json` as the CLI version.

Note: students run real commands on the server. fslab only allows the listed
commands, blocks pipes/redirection and keeps every path inside the student's
own lab, but still treat it as untrusted and keep it in the container.

## In the browser without a server (WebVM)

`labo/webvm-labo` boots a real Debian in the browser with WebVM/CheerpX.
fslab is part of that image: students type `fslab` in the browser shell and
everything runs client-side, so nothing has to be hosted except static files.
See `labo/webvm-labo/README.md` for the build (`docker build`, `make-ext2.sh`).

Because there is no server, a solved exercise ends with a **proof code**:

```
Proof code: FSLAB-4242-L2-V0-C23-8cf57a86d2
```

It encodes exercise number, level, violations and command count, signed with
the key from `$FSLAB_PROOF_KEY` or a `proof.key` file next to `fslab.py`.
Students hand the code in; verify it with the same key:

```bash
fslab.py --verify FSLAB-4242-L2-V0-C23-8cf57a86d2
```

`proof` prints the code again later. Without a key no code is printed.

## Teacher notes

- Hand out one seed to the whole class to give everyone the same task, or let
  each student run without `--seed` for an individual one.
- `.lab/history.log` shows every command with its outcome (`ok`, `exit N`,
  `VIOLATION`, `blocked`). `.lab/state.json` records the number of commands,
  violations and whether/when the task was solved.
- Exercise sizes are configured in `LEVELS` at the top of `fslab.py`; the
  name pools (`DIR_WORDS`, `FILE_WORDS`, junk names) are just lists and can be
  translated or changed freely.
