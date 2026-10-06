#!/usr/bin/env python3
"""
fslab - an interactive Linux shell that hands out random folder-structure
exercises.

The shell is real: every command (ls, cp, mv, rm, ...) is the actual program
on the system, run inside a sandboxed lab directory.  fslab only sits in
between to (1) restrict the command set, (2) keep everything inside the lab
directory and (3) enforce the exercise rules (no mkdir/touch for marked
items, rmdir-only directories, absolute/relative path requirements).

Usage:
    python3 fslab.py                 # resume or start an exercise in ~/linux-lab
    python3 fslab.py --new           # throw away the saved exercise, new random one
    python3 fslab.py --seed 4242     # reproducible exercise (same for everyone)
    python3 fslab.py --level 1|2|3   # size of the exercise (default 2)
    python3 fslab.py --root DIR      # use another lab directory
"""

import argparse
import datetime
import glob
import hashlib
import hmac
import json
import os
import random
import shlex
import shutil
import subprocess
import sys

try:
    import readline
except ImportError:  # pragma: no cover
    readline = None

VERSION = "1.0"

ALLOWED = ["ls", "pwd", "cd", "cp", "mv", "touch", "mkdir", "rm", "rmdir", "tree"]
META = ["task", "check", "hint", "proof", "help", "reset", "new", "clear", "exit", "quit"]
SHELL_CHARS = set("|;&<>`$")
MARKER = ".labid"  # hidden id file inside directories that must be copied/moved

DIR_WORDS = ["src", "docs", "tests", "config", "assets", "build", "lib", "bin",
             "data", "scripts", "images", "logs", "backup", "reports", "notes",
             "public", "vendor", "templates", "media", "api"]
FILE_WORDS = ["README.md", "main.py", "app.js", "index.html", "style.css",
              "notes.txt", "config.yaml", "Makefile", "todo.txt", "report.pdf",
              "data.csv", "setup.sh", "LICENSE", "utils.py", "logo.png",
              "schema.sql", "intro.md", "server.js", "test_main.py",
              "changelog.txt"]
JUNK_DIRS = ["tmp", "old", "cache", "trash", "scratch", "draft", "unused", "leftovers"]
JUNK_FILES = ["old.log", "debug.log", "notes.bak", "Untitled.txt", "core", "temp.txt",
              "error.txt", "copy_of_copy.txt", "thumbs.db", "crash.dump"]
STOCK_SUBDIRS = ["downloads", "incoming", "archive", "from_usb", "backup", "attachments"]

LEVELS = {
    1: dict(top=(2, 3), root_files=(0, 1), files=(1, 2), subdirs=(0, 1), subdirs_deep=(0, 0),
            depth=2, restricted=0.25, exists=0.25, junk_dirs=(1, 1), junk_files=(1, 1), junk_full=0),
    2: dict(top=(3, 4), root_files=(1, 1), files=(1, 3), subdirs=(0, 2), subdirs_deep=(0, 0),
            depth=2, restricted=0.30, exists=0.25, junk_dirs=(1, 2), junk_files=(1, 2), junk_full=1),
    3: dict(top=(3, 4), root_files=(1, 2), files=(1, 3), subdirs=(1, 2), subdirs_deep=(0, 1),
            depth=3, restricted=0.35, exists=0.30, junk_dirs=(2, 2), junk_files=(2, 3), junk_full=1),
}

USE_COLOR = sys.stdout.isatty()


def c(text, code):
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else str(text)


def bold(t): return c(t, "1")
def red(t): return c(t, "31")
def green(t): return c(t, "32")
def yellow(t): return c(t, "33")
def blue(t): return c(t, "34")
def magenta(t): return c(t, "35")
def cyan(t): return c(t, "36")
def dim(t): return c(t, "2")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def split_opts(args):
    """Separate option tokens from path tokens (stops at '--')."""
    opts, paths = [], []
    for i, a in enumerate(args):
        if a == "--":
            paths.extend(args[i + 1:])
            break
        if a.startswith("-") and len(a) > 1:
            opts.append(a)
        else:
            paths.append(a)
    return opts, paths


def has_flag(opts, *names):
    for o in opts:
        if o.startswith("--"):
            if o[2:] in names:
                return True
        else:
            for ch in o[1:]:
                if ch in names:
                    return True
    return False


def path_style(arg):
    return "abs" if arg.startswith("/") else "rel"


def now():
    return datetime.datetime.now().replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------
# proof codes - lets a student report a result when there is no server
# (e.g. inside WebVM).  The key comes from $FSLAB_PROOF_KEY or a file called
# proof.key next to this script.  Verify with:  fslab.py --verify CODE
# --------------------------------------------------------------------------

def proof_key():
    key = os.environ.get("FSLAB_PROOF_KEY", "")
    if key:
        return key
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "proof.key")) as f:
            return f.read().strip()
    except OSError:
        return ""


def proof_mac(key, seed, level, violations, commands):
    msg = "%s|%s|%s|%s" % (seed, level, violations, commands)
    return hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest()[:10]


def make_proof(seed, level, violations, commands):
    key = proof_key()
    if not key:
        return None
    return "FSLAB-%s-L%s-V%s-C%s-%s" % (seed, level, violations, commands,
                                        proof_mac(key, seed, level, violations, commands))


def verify_proof(code):
    """Return a dict with the decoded fields, or None when the code is invalid."""
    key = proof_key()
    parts = code.strip().upper().split("-")
    if not key or len(parts) != 6 or parts[0] != "FSLAB":
        return None
    try:
        seed = int(parts[1])
        level = int(parts[2].lstrip("L"))
        violations = int(parts[3].lstrip("V"))
        commands = int(parts[4].lstrip("C"))
    except ValueError:
        return None
    if not hmac.compare_digest(parts[5].lower(), proof_mac(key, seed, level, violations, commands)):
        return None
    return dict(seed=seed, level=level, violations=violations, commands=commands)


# --------------------------------------------------------------------------
# exercise generator
# --------------------------------------------------------------------------

def generate(seed, level):
    rng = random.Random(seed)
    cfg = LEVELS[level]
    for _ in range(500):
        spec = _try_generate(rng, cfg)
        if spec:
            spec.update(seed=seed, level=level, version=VERSION, created=now())
            # directories to be copied/moved carry a hidden marker file, so a
            # directory made with mkdir (and then renamed) is recognised.
            # Derived from the seed, not from rng, to keep old seeds identical.
            for rel, n in spec["targets"].items():
                if n["type"] == "dir" and n["mode"] == "restricted":
                    n["token"] = hashlib.sha1(("%s:%s" % (seed, rel)).encode()).hexdigest()[:8]
            return spec
    raise RuntimeError("could not generate an exercise")


def _try_generate(rng, cfg):
    nodes = []  # (rel, type) in DFS order, parents before children

    for f in rng.sample(FILE_WORDS, rng.randint(*cfg["root_files"])):
        nodes.append(("work/" + f, "file"))

    def fill(prefix, depth):
        for f in rng.sample(FILE_WORDS, rng.randint(*cfg["files"])):
            nodes.append((prefix + "/" + f, "file"))
        if depth < cfg["depth"]:
            lo, hi = cfg["subdirs"] if depth == 1 else cfg["subdirs_deep"]
            pool = [w for w in DIR_WORDS if w not in prefix.split("/")]
            for d in rng.sample(pool, rng.randint(lo, hi)):
                nodes.append((prefix + "/" + d, "dir"))
                fill(prefix + "/" + d, depth + 1)

    for d in rng.sample(DIR_WORDS, rng.randint(*cfg["top"])):
        nodes.append(("work/" + d, "dir"))
        fill("work/" + d, 1)

    # ---- modes: create | restricted (cp/mv only) | inherit (inside restricted) | exists
    modes = {}
    for rel, typ in nodes:
        pm = modes.get(os.path.dirname(rel))
        if pm in ("restricted", "inherit"):
            modes[rel] = "inherit"
            continue
        r = rng.random()
        if r < cfg["restricted"]:
            modes[rel] = "restricted"
        elif r < cfg["restricted"] + cfg["exists"] and pm in (None, "exists"):
            modes[rel] = "exists"
        else:
            modes[rel] = "create"

    types = dict(nodes)
    restricted = [r for r in modes if modes[r] == "restricted"]
    creates = [r for r in modes if modes[r] == "create"]
    rfiles = [r for r in modes if modes[r] in ("restricted", "inherit") and types[r] == "file"]
    if not (2 <= len(restricted) <= max(2, len(nodes) * 0.4)):
        return None
    if len(rfiles) < 1 or len(creates) < 3:
        return None
    if not any(types[r] == "dir" for r in creates) or not any(types[r] == "file" for r in creates):
        return None

    # ---- path-style requirements on some of the items the student creates
    styles = {}
    pool = creates[:]
    rng.shuffle(pool)
    for _ in range(rng.randint(1, 2)):
        if pool:
            styles[pool.pop()] = "abs"
    for _ in range(rng.randint(1, 2)):
        if pool:
            styles[pool.pop()] = "rel"

    # ---- sources for restricted items (in ~/stock or misplaced inside ~/work)
    occupied = set(r for r, _ in nodes)
    exists_dirs = ["work"] + [r for r, t in nodes if t == "dir" and modes[r] == "exists"]
    sources = {}

    def variant(name, typ):
        if typ == "dir":
            return rng.choice([name + "_old", "old-" + name, name + "2", name + "_backup"])
        stem, ext = os.path.splitext(name)
        return rng.choice(["old_" + name, stem + "_v1" + ext, stem + "-copy" + ext, name + ".orig"])

    for rel, typ in nodes:
        mode = modes[rel]
        if mode == "inherit":
            sources[rel] = sources[os.path.dirname(rel)] + "/" + os.path.basename(rel)
            continue
        if mode != "restricted":
            continue
        name = os.path.basename(rel)
        src = None
        for _ in range(20):
            src_name = variant(name, typ) if rng.random() < 0.5 else name
            if rng.random() < 0.7:
                parent = rng.choice(["stock", "stock", "stock/" + rng.choice(STOCK_SUBDIRS)])
            else:
                parent = rng.choice(exists_dirs)
            cand = parent + "/" + src_name
            if cand not in occupied and cand not in sources.values():
                src = cand
                break
        if src is None:
            return None
        sources[rel] = src
        occupied.add(src)

    # ---- junk that has to be removed
    junk = {}
    taken = set(occupied)

    def place(names, typ):
        for _ in range(20):
            cand = rng.choice(exists_dirs) + "/" + rng.choice(names)
            if cand not in taken and os.path.dirname(cand) not in junk:
                taken.add(cand)
                return cand
        return None

    for i in range(rng.randint(*cfg["junk_dirs"])):
        p = place(JUNK_DIRS, "dir")
        if p:
            junk[p] = dict(type="dir", rmdir_only=(i == 0 or rng.random() < 0.5), style=None, nonempty=False)
    for _ in range(rng.randint(*cfg["junk_files"])):
        p = place(JUNK_FILES, "file")
        if p:
            junk[p] = dict(type="file", rmdir_only=False, style=None, nonempty=False)
    for _ in range(cfg["junk_full"]):
        p = place(JUNK_DIRS, "dir")
        if p:
            junk[p] = dict(type="dir", rmdir_only=False, style=None, nonempty=True)
            for f in rng.sample(JUNK_FILES + FILE_WORDS, rng.randint(1, 3)):
                junk[p + "/" + f] = dict(type="file", rmdir_only=False, style=None, nonempty=False, child=True)
    if not junk or not any(j["rmdir_only"] for j in junk.values()):
        return None
    if rng.random() < 0.5:
        cands = [r for r, j in junk.items() if not j.get("child")]
        junk[rng.choice(cands)]["style"] = rng.choice(["abs", "rel"])

    targets = {}
    for rel, typ in nodes:
        mode = modes[rel]
        token = "%08x" % rng.getrandbits(32) if mode in ("restricted", "inherit") and typ == "file" else None
        targets[rel] = dict(type=typ, mode=mode, source=sources.get(rel), style=styles.get(rel), token=token)
    return dict(targets=targets, junk=junk)


# --------------------------------------------------------------------------
# the lab
# --------------------------------------------------------------------------

class Lab:
    def __init__(self, root):
        self.root = root
        self.labdir = os.path.join(root, ".lab")
        self.spec = None
        self.state = None
        self.cwd = root
        self.prev = root
        self.tree_warned = False
        self._matches = []
        # Optional replacement for running the real programs (used in the
        # browser, where there is no subprocess): runner(cmd, args, cwd) -> rc
        self.runner = None

    # ---- persistence -----------------------------------------------------
    @property
    def targets(self):
        return self.spec["targets"]

    @property
    def junk(self):
        return self.spec["junk"]

    def load(self):
        with open(os.path.join(self.labdir, "spec.json")) as f:
            self.spec = json.load(f)
        try:
            with open(os.path.join(self.labdir, "state.json")) as f:
                self.state = json.load(f)
        except (OSError, ValueError):
            self.state = dict(violations=0, commands=0, solved=False, started=now())
        self.cwd = os.path.join(self.root, "work")
        self.prev = self.cwd

    def save_state(self):
        with open(os.path.join(self.labdir, "state.json"), "w") as f:
            json.dump(self.state, f, indent=1)

    def start_new(self, seed, level):
        self.spec = generate(seed, level)
        self.wipe()
        for d in ("work", "stock", ".lab"):
            os.makedirs(os.path.join(self.root, d), exist_ok=True)
        self.materialize()
        with open(os.path.join(self.labdir, "spec.json"), "w") as f:
            json.dump(self.spec, f, indent=1)
        self.state = dict(violations=0, commands=0, solved=False, started=now())
        self.save_state()
        self.log("new exercise seed=%s level=%s" % (seed, level))
        self.cwd = os.path.join(self.root, "work")
        self.prev = self.cwd

    def wipe(self):
        for d in ("work", "stock", ".lab"):
            p = os.path.join(self.root, d)
            if os.path.isdir(p):
                shutil.rmtree(p)

    def materialize(self):
        def make(rel, typ, content, token=None):
            full = os.path.join(self.root, rel)
            if typ == "dir":
                os.makedirs(full, exist_ok=True)
                if token:
                    with open(os.path.join(full, MARKER), "w") as f:
                        f.write("LAB-ID %s\n" % token)
            else:
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as f:
                    f.write(content)

        for rel, n in self.targets.items():
            if n["mode"] == "exists":
                make(rel, n["type"], "This file was already here.\n")
            elif n["mode"] in ("restricted", "inherit"):
                make(n["source"], n["type"],
                     "LAB-ID %s\nThis file must be copied or moved, not recreated.\n" % n["token"],
                     n["token"])
        for rel, j in self.junk.items():
            make(rel, j["type"], "junk\n")

    def log(self, line):
        try:
            with open(os.path.join(self.labdir, "history.log"), "a") as f:
                f.write("%s  %s\n" % (now(), line))
        except OSError:
            pass

    # ---- paths -----------------------------------------------------------
    def expand_tilde(self, tok):
        if tok == "~":
            return self.root
        if tok.startswith("~/"):
            return self.root + tok[1:]
        return tok

    def resolve(self, arg):
        p = arg if os.path.isabs(arg) else os.path.join(self.cwd, arg)
        return os.path.normpath(p)

    def inside(self, full):
        return full == self.root or full.startswith(self.root + os.sep)

    def rel(self, full):
        r = os.path.relpath(full, self.root)
        return "" if r == "." else r

    def disp(self, full):
        r = self.rel(full)
        return "~" if r == "" else "~/" + r

    def descendants(self, full):
        out = []
        for dp, dns, fns in os.walk(full):
            for n in dns + fns:
                out.append(os.path.join(dp, n))
        return out

    def expand_glob(self, arg):
        if not any(ch in arg for ch in "*?["):
            return [arg]
        if os.path.isabs(arg):
            m = sorted(glob.glob(arg))
        else:
            m = sorted(os.path.relpath(x, self.cwd) for x in glob.glob(os.path.join(self.cwd, arg)))
        return m or [arg]

    def prompt(self):
        return "student@lab:%s$ " % self.disp(self.cwd)

    # ---- rule checking ---------------------------------------------------
    def vet(self, cmd, args):
        """Return (ok, message, counts_as_violation)."""
        opts, paths = split_opts(args)
        protected = {self.root, os.path.join(self.root, "work"), os.path.join(self.root, "stock")}

        for i, p in enumerate(paths):
            full = self.resolve(p)
            if not self.inside(full):
                return False, "'%s' is outside the lab. Everything happens inside %s." % (p, self.root), False
            if full == self.labdir or full.startswith(self.labdir + os.sep):
                return False, "'%s' belongs to the lab itself, hands off." % p, False
            is_dest = cmd in ("cp", "mv") and i == len(paths) - 1
            if cmd in ("rm", "rmdir", "mv") and full in protected and not is_dest:
                return False, "'%s' is part of the lab layout and cannot be removed or moved." % p, False

        if cmd == "mkdir":
            parents = has_flag(opts, "p", "parents")
            for p in paths:
                full = self.resolve(p)
                created = [full]
                if parents:
                    a = os.path.dirname(full)
                    while self.inside(a) and not os.path.exists(a):
                        created.append(a)
                        a = os.path.dirname(a)
                for cr in created:
                    v = self.check_creation(cr, path_style(p), "mkdir")
                    if v:
                        return False, v, True

        elif cmd == "touch":
            for p in paths:
                full = self.resolve(p)
                if not os.path.exists(full):
                    v = self.check_creation(full, path_style(p), "touch")
                    if v:
                        return False, v, True

        elif cmd == "rm":
            rec = has_flag(opts, "r", "R", "recursive")
            for p in paths:
                full = self.resolve(p)
                affected = [full] + (self.descendants(full) if rec and os.path.isdir(full) else [])
                for a in affected:
                    v = self.check_removal(a, path_style(p), "rm")
                    if v:
                        return False, v, True

        elif cmd == "rmdir":
            for p in paths:
                full = self.resolve(p)
                v = self.check_removal(full, path_style(p), "rmdir")
                if v:
                    return False, v, True

        elif cmd in ("cp", "mv"):
            if len(paths) < 2:
                return True, None, False
            dest, srcs = paths[-1], paths[:-1]
            dest_full = self.resolve(dest)
            if dest_full == self.root:
                return False, "You cannot %s things onto the lab root itself." % cmd, False
            if cmd == "mv":
                for s in srcs:
                    sfull = self.resolve(s)
                    for a in [sfull] + self.descendants(sfull):
                        v = self.check_removal(a, path_style(s), "mv")
                        if v:
                            return False, v, True
            for s in srcs:
                if os.path.isdir(dest_full) or len(srcs) > 1:
                    final = os.path.join(dest_full, os.path.basename(os.path.normpath(s)))
                else:
                    final = dest_full
                node = self.targets.get(self.rel(final))
                if node and node["style"] and node["style"] != path_style(dest):
                    return False, self.style_msg(final, node["style"], path_style(dest)), True
                sfull = self.resolve(s)
                if os.path.isdir(sfull):
                    for d in self.descendants(sfull):
                        mapped = os.path.normpath(os.path.join(final, os.path.relpath(d, sfull)))
                        node = self.targets.get(self.rel(mapped))
                        if node and node["style"] and node["style"] != path_style(dest):
                            return False, self.style_msg(mapped, node["style"], path_style(dest)), True

        return True, None, False

    def style_msg(self, full, wanted, used):
        return "%s must be handled with %s path (you used %s one)." % (
            self.disp(full), "an ABSOLUTE" if wanted == "abs" else "a RELATIVE",
            "an absolute" if used == "abs" else "a relative")

    def check_creation(self, full, style, cmd):
        node = self.targets.get(self.rel(full))
        if not node:
            return None
        if node["mode"] in ("restricted", "inherit"):
            return "%s is not allowed for %s: that one has to be copied or moved from ~/%s." % (
                cmd, self.disp(full), node["source"])
        if node["style"] and node["style"] != style:
            return self.style_msg(full, node["style"], style)
        return None

    def check_removal(self, full, style, cmd):
        j = self.junk.get(self.rel(full))
        if not j:
            return None
        if j["rmdir_only"] and cmd != "rmdir":
            return "%s is an empty directory that must be removed with rmdir (not %s)." % (self.disp(full), cmd)
        if j["style"] and j["style"] != style:
            return self.style_msg(full, j["style"], style)
        return None

    # ---- command execution -----------------------------------------------
    def handle(self, line):
        try:
            tokens = shlex.split(line)
        except ValueError as e:
            print("syntax error: %s" % e)
            return
        if not tokens:
            return
        cmd, raw_args = tokens[0], tokens[1:]

        if cmd in META:
            self.meta(cmd, raw_args)
            return
        if cmd not in ALLOWED:
            print("%s: not available in the lab. You have: %s" % (cmd, " ".join(ALLOWED)))
            print(dim("(plus: %s)" % " ".join(META)))
            self.log("[unknown] %s" % line)
            return
        for t in tokens:
            if SHELL_CHARS & set(t):
                print("Pipes, redirection, chaining and variables are disabled in the lab. Wildcards (*) do work.")
                self.log("[blocked-syntax] %s" % line)
                return

        args = []
        for a in raw_args:
            a = self.expand_tilde(a)
            if a.startswith("-") and len(a) > 1:
                args.append(a)
            else:
                args.extend(self.expand_glob(a))

        self.state["commands"] += 1
        if cmd == "pwd":
            print(self.cwd)
            self.log("[ok] %s" % line)
            return
        if cmd == "cd":
            self.do_cd(args)
            self.log("[ok] %s" % line)
            return

        ok, msg, violation = self.vet(cmd, args)
        if not ok:
            if violation:
                self.state["violations"] += 1
                print(red("✗ rule violation: ") + msg)
                print(dim("  (command not executed - violations so far: %d)" % self.state["violations"]))
                self.log("[VIOLATION] %s   <- %s" % (line, msg))
            else:
                print(red("✗ blocked: ") + msg)
                self.log("[blocked] %s   <- %s" % (line, msg))
            self.save_state()
            return

        if cmd == "tree" and (self.runner or shutil.which("tree") is None):
            if not self.runner and not self.tree_warned:
                print(dim("(the real `tree` is not installed on this machine - using a built-in look-alike; "
                          "install it with `sudo apt install tree` or `brew install tree`)"))
                self.tree_warned = True
            self.builtin_tree(args)
            rc = 0
        elif self.runner:
            rc = self.runner(cmd, args, self.cwd)
        else:
            env = dict(os.environ, HOME=self.root)
            try:
                rc = subprocess.run([cmd] + args, cwd=self.cwd, env=env).returncode
            except FileNotFoundError:
                print("%s: program not found on this system" % cmd)
                rc = 127
        self.log("[%s] %s" % ("ok" if rc == 0 else "exit %d" % rc, line))
        self.save_state()

    def do_cd(self, args):
        if len(args) > 1:
            print("cd: too many arguments")
            return
        target = args[0] if args else self.root
        if target == "-":
            target = self.prev
        full = self.resolve(target)
        if not self.inside(full):
            print(red("✗ blocked: ") + "you cannot leave the lab (%s)." % self.root)
            return
        if full == self.labdir or full.startswith(self.labdir + os.sep):
            print(red("✗ blocked: ") + "that directory belongs to the lab itself.")
            return
        if not os.path.exists(full):
            print("cd: no such file or directory: %s" % target)
            return
        if not os.path.isdir(full):
            print("cd: not a directory: %s" % target)
            return
        self.prev, self.cwd = self.cwd, full

    def builtin_tree(self, args):
        opts, paths = split_opts(args)
        max_depth = None
        if "-L" in opts and paths:
            try:
                max_depth = int(paths.pop(0))
            except ValueError:
                pass
        show_all = has_flag(opts, "a", "all")
        dirs_only = has_flag(opts, "d")
        nd = nf = 0

        def walk(d, prefix, depth):
            nonlocal nd, nf
            if max_depth is not None and depth > max_depth:
                return
            try:
                entries = sorted(os.listdir(d), key=lambda s: s.lower())
            except OSError:
                return
            if not show_all:
                entries = [e for e in entries if not e.startswith(".")]
            if dirs_only:
                entries = [e for e in entries if os.path.isdir(os.path.join(d, e))]
            for i, e in enumerate(entries):
                last = i == len(entries) - 1
                full = os.path.join(d, e)
                isdir = os.path.isdir(full)
                print(prefix + ("└── " if last else "├── ") + (blue(e) if isdir else e))
                if isdir:
                    nd += 1
                    walk(full, prefix + ("    " if last else "│   "), depth + 1)
                else:
                    nf += 1

        for p in (paths or ["."]):
            full = self.resolve(p)
            if not os.path.isdir(full):
                print("%s  [error opening dir]" % p)
                continue
            print(blue(p))
            walk(full, "", 1)
        print("\n%d director%s, %d file%s" % (nd, "y" if nd == 1 else "ies", nf, "" if nf == 1 else "s"))

    # ---- meta commands ---------------------------------------------------
    def meta(self, cmd, args):
        if cmd in ("exit", "quit"):
            raise SystemExit(0)
        if cmd == "clear":
            print("\033[2J\033[H", end="")
        elif cmd == "help":
            self.show_help()
        elif cmd == "task":
            self.show_task()
        elif cmd == "check":
            self.check(verbose=True)
        elif cmd == "hint":
            self.hint()
        elif cmd == "proof":
            self.show_proof()
        elif cmd in ("reset", "new"):
            what = "restart this exercise from scratch" if cmd == "reset" else "start a NEW random exercise"
            if not self.confirm("This will %s and wipe ~/work and ~/stock. Continue?" % what):
                print("cancelled")
                return
            level = self.spec["level"]
            seed = self.spec["seed"] if cmd == "reset" else random.randrange(1, 100000)
            self.start_new(seed, level)
            self.show_task()

    def confirm(self, question):
        try:
            ans = input(question + " [y/N] ")
        except EOFError:
            ans = ""
        return ans.strip().lower() in ("y", "yes")

    def show_help(self):
        print(bold("Available commands"))
        print("  " + "  ".join(ALLOWED))
        print(bold("Lab commands"))
        print("  task    show the exercise again        check   verify your work")
        print("  hint    one nudge in the right direction reset   same exercise, fresh start")
        print("  new     a different random exercise     exit    leave the lab")
        print(bold("Notes"))
        print("  ~ stands for the lab directory (%s); ~/... counts as an absolute path." % self.root)
        print("  Wildcards like *.txt work. Pipes, redirection and ; && are off.")

    def annotation(self, rel, n):
        if n["mode"] == "restricted":
            return yellow("★ no mkdir/touch → copy or move it from ~/%s" % n["source"])
        if n["mode"] == "inherit":
            return dim("(comes along: ~/%s)" % n["source"])
        if n["mode"] == "exists":
            return dim("(already there)")
        if n["style"] == "abs":
            return cyan("◆ create it with an ABSOLUTE path")
        if n["style"] == "rel":
            return magenta("◆ create it with a RELATIVE path")
        return ""

    def show_task(self):
        s = self.spec
        print()
        print(bold("═══ Exercise #%d (level %d) ═══" % (s["seed"], s["level"])))
        print("Lab directory: %s   (shown as ~ in the prompt)" % self.root)
        print("Make ~/work look EXACTLY like this - nothing more, nothing less:")
        print()
        rows = [("work/", "")]
        children = {}
        for rel in self.targets:
            children.setdefault(os.path.dirname(rel), []).append(rel)

        def walk(parent, prefix):
            kids = sorted(children.get(parent, []), key=lambda r: os.path.basename(r).lower())
            for i, k in enumerate(kids):
                last = i == len(kids) - 1
                n = self.targets[k]
                name = os.path.basename(k) + ("/" if n["type"] == "dir" else "")
                rows.append((prefix + ("└── " if last else "├── ") + name, self.annotation(k, n)))
                if n["type"] == "dir":
                    walk(k, prefix + ("    " if last else "│   "))

        walk("work", "")
        width = max(len(r[0]) for r in rows) + 2
        for left, ann in rows:
            print("  " + left.ljust(width) + ann)

        print()
        print(bold("Remove from ~/work") + " (everything that is not in the picture above must go):")
        for rel, j in self.junk.items():
            if j.get("child"):
                continue
            if j["type"] == "file":
                what = "file"
            elif j["nonempty"]:
                what = "directory with stuff inside"
            else:
                what = "empty directory"
            extra = ""
            if j["rmdir_only"]:
                extra += "  " + red("rmdir only - no rm!")
            if j["style"] == "abs":
                extra += "  " + cyan("◆ remove it with an ABSOLUTE path")
            if j["style"] == "rel":
                extra += "  " + magenta("◆ remove it with a RELATIVE path")
            print("  ~/%-28s %s%s" % (rel + ("/" if j["type"] == "dir" else ""), what, extra))
        misplaced = [n["source"] for n in self.targets.values()
                     if n["mode"] == "restricted" and n["source"].startswith("work/")]
        if misplaced:
            print("  " + dim("(items marked ★ that currently live inside ~/work must end up at their new place only)"))
        print()
        print(bold("Rules"))
        print("  • Commands: %s   (type `help` for the lab commands)" % " ".join(ALLOWED))
        print("  • " + yellow("★") + " items may NOT be made with mkdir/touch - bring them over with cp or mv.")
        print("  • " + cyan("◆") + " items must be created/removed with the stated kind of path (~/... is absolute).")
        print("  • " + red("rmdir only") + " directories may not be removed with rm.")
        print("  • ~/stock may be left in any state. Breaking a rule blocks the command and is counted.")
        print("  • Type " + bold("check") + " when you think you are done.")
        print()

    # ---- verification ----------------------------------------------------
    def check(self, verbose=True):
        work = os.path.join(self.root, "work")
        actual = {}
        for dp, dns, fns in os.walk(work):
            for d in dns:
                actual[self.rel(os.path.join(dp, d))] = "dir"
            for f in fns:
                if f != MARKER:
                    actual[self.rel(os.path.join(dp, f))] = "file"

        missing, wrong_type, bad_content = [], [], []
        for rel, n in self.targets.items():
            if rel not in actual:
                missing.append(rel)
            elif actual[rel] != n["type"]:
                wrong_type.append(rel)
            elif n["token"]:
                try:
                    path = os.path.join(self.root, rel)
                    if n["type"] == "dir":
                        path = os.path.join(path, MARKER)
                    with open(path, errors="replace") as f:
                        if n["token"] not in f.read():
                            bad_content.append(rel)
                except OSError:
                    bad_content.append(rel)
        extra = []
        for rel in sorted(actual):
            if rel in self.targets:
                continue
            if any(rel.startswith(e + "/") for e in extra):
                continue
            extra.append(rel)

        ok = not (missing or wrong_type or bad_content or extra)
        present = len(self.targets) - len(missing) - len(wrong_type)
        if verbose:
            print()
            print(bold("── check ──────────────────────────────────────"))
            print((green("✔") if present == len(self.targets) else yellow("•")) +
                  " %d/%d target items present" % (present, len(self.targets)))
            if missing:
                print(red("✘ missing (%d):" % len(missing)))
                for r in missing:
                    print("    ~/%s%s" % (r, "/" if self.targets[r]["type"] == "dir" else ""))
            if wrong_type:
                print(red("✘ wrong kind (%d):" % len(wrong_type)))
                for r in wrong_type:
                    print("    ~/%s should be a %s" % (r, self.targets[r]["type"]))
            if bad_content:
                print(red("✘ not the original (%d):" % len(bad_content)))
                for r in bad_content:
                    print("    ~/%s is not the original %s from ~/%s (recreated instead of copied/moved?)"
                          % (r, self.targets[r]["type"], self.targets[r]["source"]))
            if extra:
                print(red("✘ should not be there (%d):" % len(extra)))
                for r in extra:
                    print("    ~/%s%s" % (r, "/" if actual[r] == "dir" else ""))
            print("rule violations: %s   commands run: %d" % (
                (green("0") if self.state["violations"] == 0 else red(str(self.state["violations"]))),
                self.state["commands"]))
            if ok:
                print(green(bold("RESULT: SOLVED ✔")) + ("" if self.state["violations"] == 0 else
                      yellow("  (but with %d rule violation(s))" % self.state["violations"])))
            else:
                print(yellow("RESULT: not yet - keep going (type `hint` if you are stuck)"))
            print()
        if ok and not self.state["solved"]:
            self.state["solved"] = True
            self.state["solved_at"] = now()
            self.log("SOLVED with %d violations, %d commands" % (self.state["violations"], self.state["commands"]))
        self.save_state()
        if ok and verbose and proof_key():
            self.show_proof()
            print()
        return ok

    def show_proof(self):
        if not self.state.get("solved"):
            print("Not solved yet - the proof code appears once `check` passes.")
            return
        code = make_proof(self.spec["seed"], self.spec["level"], self.state["violations"], self.state["commands"])
        if not code:
            print("No proof key configured on this machine, so there is no proof code.")
            return
        print(bold("Proof code: ") + green(code))
        print(dim("Hand this code in; your teacher can verify it with `fslab --verify %s`." % code))

    def hint(self):
        work = os.path.join(self.root, "work")
        actual = set()
        for dp, dns, fns in os.walk(work):
            for n in dns + fns:
                if n != MARKER:
                    actual.add(self.rel(os.path.join(dp, n)))
        for rel, n in self.targets.items():
            if rel not in actual:
                kind = "directory" if n["type"] == "dir" else "file"
                if n["mode"] in ("restricted", "inherit"):
                    print("Missing: ~/%s (%s). It exists as ~/%s - use cp or mv to bring it over." % (rel, kind, n["source"]))
                else:
                    how = "mkdir" if n["type"] == "dir" else "touch"
                    style = {"abs": " using an absolute path (starts with / or ~/)",
                             "rel": " using a relative path (seen from your current directory - `pwd`)",
                             None: ""}[n["style"]]
                    print("Missing: ~/%s (%s). Create it with %s%s." % (rel, kind, how, style))
                return
        for rel in sorted(actual):
            if rel not in self.targets:
                j = self.junk.get(rel)
                full = os.path.join(self.root, rel)
                if j and j["rmdir_only"]:
                    print("~/%s should not be there. It is empty, so rmdir is the tool." % rel)
                elif os.path.isdir(full) and os.listdir(full):
                    print("~/%s should not be there. It has contents, so rm needs its recursive option." % rel)
                elif os.path.isdir(full):
                    print("~/%s should not be there (empty directory)." % rel)
                else:
                    print("~/%s should not be there (file) - rm it." % rel)
                return
        print("The structure looks complete. Run `check` to verify the details.")

    # ---- readline --------------------------------------------------------
    def complete(self, text, state):
        if state == 0:
            buf = readline.get_line_buffer()
            beg = readline.get_begidx()
            if buf[:beg].strip() == "":
                self._matches = [w + " " for w in ALLOWED + META if w.startswith(text)]
            else:
                self._matches = self.path_candidates(text)
        return self._matches[state] if state < len(self._matches) else None

    def path_candidates(self, text):
        t = self.expand_tilde(text)
        d, base = os.path.split(t)
        search = self.resolve(d) if d else self.cwd
        if not self.inside(search):
            return []
        try:
            names = os.listdir(search)
        except OSError:
            return []
        out = []
        prefix = text[:len(text) - len(base)]
        for n in sorted(names):
            if not n.startswith(base) or (base == "" and n.startswith(".")):
                continue
            cand = prefix + n
            if os.path.isdir(os.path.join(search, n)):
                cand += "/"
            else:
                cand += " "
            out.append(cand)
        return out

    def repl(self):
        if readline:
            readline.set_completer_delims(" \t\n")
            readline.set_completer(self.complete)
            if "libedit" in (readline.__doc__ or ""):
                readline.parse_and_bind("bind ^I rl_complete")
            else:
                readline.parse_and_bind("tab: complete")
        while True:
            try:
                line = input(self.prompt())
            except EOFError:
                print()
                return
            except KeyboardInterrupt:
                print()
                continue
            line = line.strip()
            if not line:
                continue
            try:
                self.handle(line)
            except SystemExit:
                print("bye")
                return


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="interactive Linux folder-structure exercises")
    ap.add_argument("--root", default=os.path.expanduser("~/linux-lab"),
                    help="lab directory (default: ~/linux-lab)")
    ap.add_argument("--seed", type=int, help="exercise number; same seed = same exercise")
    ap.add_argument("--level", type=int, choices=[1, 2, 3], default=2, help="size of the exercise")
    ap.add_argument("--new", action="store_true", help="discard the saved exercise and start a new one")
    ap.add_argument("--verify", metavar="CODE", help="teacher: verify a proof code and exit")
    a = ap.parse_args()

    if a.verify:
        if not proof_key():
            sys.exit("no proof key: set FSLAB_PROOF_KEY or put a proof.key file next to fslab.py")
        info = verify_proof(a.verify)
        if not info:
            print(red("INVALID") + " - this is not a genuine proof code for this key.")
            sys.exit(1)
        print(green("VALID") + "  exercise #%(seed)d (level %(level)d) solved with %(violations)d violation(s) "
              "in %(commands)d commands" % info)
        sys.exit(0)

    root = os.path.realpath(os.path.abspath(a.root))
    lab = Lab(root)
    has_saved = os.path.exists(os.path.join(root, ".lab", "spec.json"))

    if has_saved and not a.new and a.seed is None:
        lab.load()
        print(dim("Resuming the saved exercise in %s (use --new for a fresh one)." % root))
    else:
        if os.path.isdir(root) and os.listdir(root) and not os.path.isdir(os.path.join(root, ".lab")):
            sys.exit("%s exists and does not look like a lab directory - refusing to touch it. "
                     "Pick another place with --root." % root)
        os.makedirs(root, exist_ok=True)
        lab.start_new(a.seed if a.seed is not None else random.randrange(1, 100000), a.level)

    print(bold("fslab %s" % VERSION) + " - type `task` to see the exercise, `help` for the commands, `check` to verify.")
    lab.show_task()
    lab.repl()


if __name__ == "__main__":
    main()
