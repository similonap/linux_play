"""
Browser backend for fslab (runs inside Pyodide).

Pyodide has no subprocess, so the handful of commands the lab allows are
re-implemented here on top of the (real) in-memory file system.  fslab.py does
all the rule checking; this module only does the actual work once a command
has been approved, and wraps a Lab in a small API for the JavaScript terminal.
"""

import contextlib
import io
import json
import os
import shutil
import stat
import time

import fslab

WIDTH = 80  # terminal columns, updated from JS


# --------------------------------------------------------------------------
# option parsing
# --------------------------------------------------------------------------

def parse(cmd, args, short, long=()):
    """Return (flags, operands) or raise ValueError with a GNU-style message."""
    flags, ops = set(), []
    for i, a in enumerate(args):
        if a == "--":
            ops.extend(args[i + 1:])
            break
        if a.startswith("--") and len(a) > 2:
            name = a[2:]
            if name not in long:
                raise ValueError("%s: unrecognized option '%s'" % (cmd, a))
            flags.add(name)
        elif a.startswith("-") and len(a) > 1:
            for ch in a[1:]:
                if ch not in short:
                    raise ValueError("%s: invalid option -- '%s'" % (cmd, ch))
                flags.add(ch)
        else:
            ops.append(a)
    return flags, ops


def has(flags, *names):
    return any(n in flags for n in names)


def resolve(cwd, p):
    return os.path.normpath(p if os.path.isabs(p) else os.path.join(cwd, p))


def err(msg):
    print(msg)
    return 1


def reason(e):
    return {2: "No such file or directory", 13: "Permission denied", 17: "File exists",
            20: "Not a directory", 21: "Is a directory", 39: "Directory not empty"}.get(
        e.errno, e.strerror or "error")


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_mkdir(args, cwd):
    try:
        flags, ops = parse("mkdir", args, "pv", ("parents", "verbose"))
    except ValueError as e:
        return err(e)
    if not ops:
        return err("mkdir: missing operand")
    rc = 0
    for p in ops:
        full = resolve(cwd, p)
        try:
            if has(flags, "p", "parents"):
                missing = []
                a = full
                while not os.path.exists(a):
                    missing.append(a)
                    a = os.path.dirname(a)
                if os.path.exists(full) and not os.path.isdir(full):
                    raise FileExistsError(17, "File exists")
                os.makedirs(full, exist_ok=True)
                if has(flags, "v", "verbose"):
                    for m in reversed(missing):
                        print("mkdir: created directory '%s'" % (m if os.path.isabs(p) else os.path.relpath(m, cwd)))
            else:
                os.mkdir(full)
                if has(flags, "v", "verbose"):
                    print("mkdir: created directory '%s'" % p)
        except OSError as e:
            rc = err("mkdir: cannot create directory '%s': %s" % (p, reason(e)))
    return rc


def cmd_touch(args, cwd):
    try:
        flags, ops = parse("touch", args, "c", ("no-create",))
    except ValueError as e:
        return err(e)
    if not ops:
        return err("touch: missing file operand")
    rc = 0
    for p in ops:
        full = resolve(cwd, p)
        try:
            if os.path.exists(full):
                os.utime(full, None)
            elif not has(flags, "c", "no-create"):
                open(full, "a").close()
        except OSError as e:
            rc = err("touch: cannot touch '%s': %s" % (p, reason(e)))
    return rc


def cmd_rm(args, cwd):
    try:
        flags, ops = parse("rm", args, "rRfdiv", ("recursive", "force", "dir", "verbose"))
    except ValueError as e:
        return err(e)
    force = has(flags, "f", "force")
    rec = has(flags, "r", "R", "recursive")
    verbose = has(flags, "v", "verbose")
    if not ops:
        return 0 if force else err("rm: missing operand")
    rc = 0
    for p in ops:
        full = resolve(cwd, p)
        if not os.path.lexists(full):
            if not force:
                rc = err("rm: cannot remove '%s': No such file or directory" % p)
            continue
        try:
            if os.path.isdir(full) and not os.path.islink(full):
                if rec:
                    shutil.rmtree(full)
                elif has(flags, "d", "dir"):
                    os.rmdir(full)
                else:
                    rc = err("rm: cannot remove '%s': Is a directory" % p)
                    continue
            else:
                os.remove(full)
            if verbose:
                print("removed '%s'" % p)
        except OSError as e:
            rc = err("rm: cannot remove '%s': %s" % (p, reason(e)))
    return rc


def cmd_rmdir(args, cwd):
    try:
        flags, ops = parse("rmdir", args, "pv", ("parents", "verbose"))
    except ValueError as e:
        return err(e)
    if not ops:
        return err("rmdir: missing operand")
    rc = 0
    for p in ops:
        full = resolve(cwd, p)
        try:
            os.rmdir(full)
            if has(flags, "v", "verbose"):
                print("rmdir: removing directory, '%s'" % p)
            if has(flags, "p", "parents"):
                parent = os.path.dirname(full)
                while parent != cwd and len(parent) > 1:
                    try:
                        os.rmdir(parent)
                    except OSError:
                        break
                    parent = os.path.dirname(parent)
        except OSError as e:
            rc = err("rmdir: failed to remove '%s': %s" % (p, reason(e)))
    return rc


def _plan(cmd, flags, ops, cwd):
    """Pair every source with its final destination, like cp/mv do."""
    if len(ops) < 2:
        if not ops:
            return None, "%s: missing file operand" % cmd
        return None, "%s: missing destination file operand after '%s'" % (cmd, ops[0])
    *srcs, dest = ops
    dfull = resolve(cwd, dest)
    if len(srcs) > 1 and not os.path.isdir(dfull):
        return None, "%s: target '%s' is not a directory" % (cmd, dest)
    pairs = []
    for s in srcs:
        sfull = resolve(cwd, s)
        final = os.path.join(dfull, os.path.basename(sfull)) if os.path.isdir(dfull) else dfull
        pairs.append((s, sfull, final))
    return pairs, None


def _inside(path, parent):
    return path == parent or path.startswith(parent.rstrip("/") + "/")


def cmd_cp(args, cwd):
    try:
        flags, ops = parse("cp", args, "rRfnivpa", ("recursive", "force", "no-clobber", "verbose"))
    except ValueError as e:
        return err(e)
    pairs, msg = _plan("cp", flags, ops, cwd)
    if msg:
        return err(msg)
    rec = has(flags, "r", "R", "a", "recursive")
    rc = 0
    for s, sfull, final in pairs:
        if not os.path.lexists(sfull):
            rc = err("cp: cannot stat '%s': No such file or directory" % s)
            continue
        if os.path.isdir(sfull):
            if not rec:
                rc = err("cp: -r not specified; omitting directory '%s'" % s)
                continue
            if _inside(final, sfull):
                rc = err("cp: cannot copy a directory, '%s', into itself, '%s'" % (s, os.path.relpath(final, cwd)))
                continue
            if os.path.isfile(final):
                rc = err("cp: cannot overwrite non-directory '%s' with directory '%s'" % (final, s))
                continue
        elif os.path.isdir(final):
            rc = err("cp: cannot overwrite directory '%s' with non-directory" % final)
            continue
        if sfull == final:
            rc = err("cp: '%s' and '%s' are the same file" % (s, s))
            continue
        if os.path.exists(final) and has(flags, "n", "no-clobber"):
            continue
        try:
            if os.path.isdir(sfull):
                shutil.copytree(sfull, final, dirs_exist_ok=True)
            else:
                shutil.copy2(sfull, final)
            if has(flags, "v", "verbose"):
                print("'%s' -> '%s'" % (s, os.path.relpath(final, cwd)))
        except OSError as e:
            rc = err("cp: cannot create regular file '%s': %s" % (os.path.relpath(final, cwd), reason(e)))
    return rc


def cmd_mv(args, cwd):
    try:
        flags, ops = parse("mv", args, "fnivu", ("force", "no-clobber", "verbose"))
    except ValueError as e:
        return err(e)
    pairs, msg = _plan("mv", flags, ops, cwd)
    if msg:
        return err(msg)
    rc = 0
    for s, sfull, final in pairs:
        if not os.path.lexists(sfull):
            rc = err("mv: cannot stat '%s': No such file or directory" % s)
            continue
        if sfull == final:
            rc = err("mv: '%s' and '%s' are the same file" % (s, s))
            continue
        if os.path.isdir(sfull) and _inside(final, sfull):
            rc = err("mv: cannot move '%s' to a subdirectory of itself, '%s'" % (s, os.path.relpath(final, cwd)))
            continue
        if os.path.isdir(final) and not os.path.isdir(sfull):
            rc = err("mv: cannot overwrite directory '%s' with non-directory" % final)
            continue
        if os.path.isfile(final) and os.path.isdir(sfull):
            rc = err("mv: cannot overwrite non-directory '%s' with directory '%s'" % (final, s))
            continue
        if os.path.exists(final) and has(flags, "n", "no-clobber"):
            continue
        try:
            if os.path.isdir(final) and os.path.isdir(sfull):
                if os.listdir(final):
                    rc = err("mv: cannot overwrite '%s': Directory not empty" % os.path.relpath(final, cwd))
                    continue
                os.rmdir(final)
            shutil.move(sfull, final)
            if has(flags, "v", "verbose"):
                print("renamed '%s' -> '%s'" % (s, os.path.relpath(final, cwd)))
        except OSError as e:
            rc = err("mv: cannot move '%s' to '%s': %s" % (s, os.path.relpath(final, cwd), reason(e)))
    return rc


# ---- ls --------------------------------------------------------------------

def human(n):
    for unit in ("", "K", "M", "G"):
        if n < 1024:
            return ("%d%s" % (n, unit)) if unit == "" or n >= 10 else "%.1f%s" % (n, unit)
        n /= 1024.0
    return "%dT" % n


def decorate(name, full, flags):
    isdir = os.path.isdir(full)
    out = fslab.blue(fslab.bold(name)) if isdir else name
    if has(flags, "F"):
        if isdir:
            out += "/"
        elif os.access(full, os.X_OK):
            out += "*"
    return out


def plain_len(name, full, flags):
    n = len(name)
    if has(flags, "F") and (os.path.isdir(full) or os.access(full, os.X_OK)):
        n += 1
    return n


def long_line(name, full, flags):
    st = os.lstat(full)
    mode = stat.filemode(st.st_mode)
    when = time.localtime(st.st_mtime)
    if time.time() - st.st_mtime > 180 * 86400:
        stamp = time.strftime("%b %e  %Y", when)
    else:
        stamp = time.strftime("%b %e %H:%M", when)
    size = human(st.st_size) if has(flags, "h") else str(st.st_size)
    return mode, str(st.st_nlink), "student", "student", size, stamp, decorate(name, full, flags)


def print_entries(dirpath, names, flags):
    names = sorted(names, key=lambda n: n.lower().lstrip("."))
    if has(flags, "l"):
        rows = [long_line(n, os.path.join(dirpath, n), flags) for n in names]
        if not rows:
            return
        widths = [max(len(r[i]) for r in rows) for i in range(6)]
        for r in rows:
            print("%s %s %s %s %s %s %s" % (r[0], r[1].rjust(widths[1]), r[2].ljust(widths[2]),
                                            r[3].ljust(widths[3]), r[4].rjust(widths[4]),
                                            r[5], r[6]))
        return
    if has(flags, "1") or not names:
        for n in names:
            print(decorate(n, os.path.join(dirpath, n), flags))
        return
    # column-major layout like ls does on a terminal
    lens = [plain_len(n, os.path.join(dirpath, n), flags) for n in names]
    best = None
    for ncols in range(len(names), 0, -1):
        nrows = -(-len(names) // ncols)
        cols = [lens[i * nrows:(i + 1) * nrows] for i in range(ncols)]
        cols = [c for c in cols if c]
        widths = [max(c) for c in cols]
        if sum(widths) + 2 * (len(cols) - 1) <= WIDTH or ncols == 1:
            best = (nrows, widths)
            break
    nrows, widths = best
    for r in range(nrows):
        line = []
        for ci, w in enumerate(widths):
            i = ci * nrows + r
            if i >= len(names):
                break
            cell = decorate(names[i], os.path.join(dirpath, names[i]), flags)
            line.append(cell + " " * (w - lens[i]))
        print("  ".join(line).rstrip())


def cmd_ls(args, cwd):
    try:
        flags, ops = parse("ls", args, "aAlRd1Fh", ("all", "almost-all", "recursive", "directory"))
    except ValueError as e:
        return err(e)
    for long, short in (("all", "a"), ("almost-all", "A"), ("recursive", "R"), ("directory", "d")):
        if long in flags:
            flags.add(short)
    rc = 0
    files, dirs = [], []
    for p in ops or ["."]:
        full = resolve(cwd, p)
        if not os.path.lexists(full):
            rc = err("ls: cannot access '%s': No such file or directory" % p)
        elif os.path.isdir(full) and not has(flags, "d"):
            dirs.append((p, full))
        else:
            files.append((p, full))
    if files:
        files.sort(key=lambda t: t[0].lower())
        if has(flags, "l"):
            rows = [long_line(p, full, flags) for p, full in files]
            widths = [max(len(r[i]) for r in rows) for i in range(6)]
            for r in rows:
                print("%s %s %s %s %s %s %s" % (r[0], r[1].rjust(widths[1]), r[2].ljust(widths[2]),
                                                r[3].ljust(widths[3]), r[4].rjust(widths[4]), r[5], r[6]))
        else:
            for p, full in files:
                print(decorate(p, full, flags))
    dirs.sort(key=lambda t: t[0].lower())
    heading = len(ops) > 1 or has(flags, "R")
    first = not files

    def show(label, full):
        nonlocal first
        if not first:
            print()
        first = False
        if heading:
            print(label + ":")
        try:
            names = os.listdir(full)
        except OSError as e:
            print("ls: cannot open directory '%s': %s" % (label, reason(e)))
            return
        if has(flags, "a"):
            names += [".", ".."]
        elif not has(flags, "A"):
            names = [n for n in names if not n.startswith(".")]
        if has(flags, "l"):
            total = sum((os.lstat(os.path.join(full, n)).st_blocks or 0) for n in names
                        if n not in (".", "..")) // 2
            print("total %d" % total)
        print_entries(full, names, flags)
        if has(flags, "R"):
            for n in sorted(names, key=str.lower):
                sub = os.path.join(full, n)
                if n not in (".", "..") and os.path.isdir(sub) and not os.path.islink(sub):
                    show(os.path.join(label, n) if label != "." else "./" + n, sub)

    for label, full in dirs:
        show(label, full)
    return rc


COMMANDS = {"ls": cmd_ls, "cp": cmd_cp, "mv": cmd_mv, "rm": cmd_rm, "rmdir": cmd_rmdir,
            "mkdir": cmd_mkdir, "touch": cmd_touch}


def runner(cmd, args, cwd):
    return COMMANDS[cmd](args, cwd)


# --------------------------------------------------------------------------
# session API used by the JavaScript terminal
# --------------------------------------------------------------------------

class Session:
    def __init__(self, root, confirm, seed=None, level=2, fresh=False):
        fslab.USE_COLOR = True
        self.lab = fslab.Lab(root)
        self.lab.runner = runner
        self.lab.confirm = confirm
        saved = os.path.exists(os.path.join(root, ".lab", "spec.json"))
        if saved:
            self.lab.load()
        stale = saved and seed is not None and self.lab.spec["seed"] != seed
        if not saved or fresh or stale:
            os.makedirs(root, exist_ok=True)
            self.lab.start_new(seed if seed is not None else __import__("random").randrange(1, 100000),
                               level if level in (1, 2, 3) else 2)
            saved = False
        self.resumed = saved

    def capture(self, fn, *a):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                fn(*a)
            except SystemExit:
                print("This is the browser lab - just close the tab. Your progress is saved.")
        return buf.getvalue().replace("\r\n", "\n").replace("\n", "\r\n")

    def banner(self):
        head = fslab.bold("fslab %s" % fslab.VERSION) + " - type `task` to see the exercise, `help` for the commands, `check` to verify."
        if self.resumed:
            head += "\n" + fslab.dim("Resuming your saved exercise (use `new` for a fresh one).")
        return self.capture(lambda: (print(head), self.lab.show_task()))

    def run(self, line):
        return self.capture(self.lab.handle, line)

    def prompt(self):
        return self.lab.prompt()

    def complete(self, line):
        lab = self.lab
        head, _, text = line.rpartition(" ")
        if head.strip() == "":
            return json.dumps([w + " " for w in fslab.ALLOWED + fslab.META if w.startswith(text)])
        return json.dumps(lab.path_candidates(text))

    def info(self):
        s, st = self.lab.spec, self.lab.state
        return json.dumps(dict(seed=s["seed"], level=s["level"], commands=st["commands"],
                               violations=st["violations"], solved=st.get("solved", False)))
