#!/usr/bin/env python3
"""
fslab web - serves fslab.py in the browser.

Every student gets their own fslab process running in a real pseudo-terminal,
bridged to an xterm.js terminal over a WebSocket.  The commands are still the
real binaries on the server (run this inside the provided Docker image).

    pip install aiohttp
    python3 server.py                        # http://localhost:8080
    FSLAB_TEACHER_KEY=secret python3 server.py   # enables /teacher?key=secret

Environment:
    FSLAB_LABS         directory that holds one lab per student (default ./labs)
    FSLAB_PORT         port (default 8080)
    FSLAB_TEACHER_KEY  key for the teacher dashboard (unset = dashboard off)
    FSLAB_LEVEL        default level for new students (default 2)
    FSLAB_SEED         fixed seed for every new student (default: random)
"""

import asyncio
import fcntl
import json
import os
import pty
import re
import secrets
import signal
import struct
import sys
import termios
import time

from aiohttp import web, WSMsgType

HERE = os.path.dirname(os.path.abspath(__file__))
FSLAB = os.path.join(os.path.dirname(HERE), "fslab.py")
STATIC = os.path.join(HERE, "static")
LABS = os.path.abspath(os.environ.get("FSLAB_LABS", os.path.join(HERE, "labs")))
TEACHER_KEY = os.environ.get("FSLAB_TEACHER_KEY", "")
DEFAULT_LEVEL = os.environ.get("FSLAB_LEVEL", "2")
FIXED_SEED = os.environ.get("FSLAB_SEED", "")

SID_RE = re.compile(r"^[A-Za-z0-9_-]{8,40}$")
SESSIONS_FILE = os.path.join(LABS, "sessions.json")

active = {}  # sid -> Terminal


# --------------------------------------------------------------------------
# session registry (names, timestamps)
# --------------------------------------------------------------------------

def load_sessions():
    try:
        with open(SESSIONS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_sessions(data):
    os.makedirs(LABS, exist_ok=True)
    tmp = SESSIONS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, SESSIONS_FILE)


def touch_session(sid, name=None):
    data = load_sessions()
    entry = data.setdefault(sid, {"name": "", "created": time.time()})
    if name:
        entry["name"] = name[:40]
    entry["last_seen"] = time.time()
    save_sessions(data)
    return entry


def lab_root(sid):
    return os.path.join(LABS, sid)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def session_summary(sid, entry):
    root = lab_root(sid)
    state = read_json(os.path.join(root, ".lab", "state.json")) or {}
    spec = read_json(os.path.join(root, ".lab", "spec.json")) or {}
    return {
        "sid": sid,
        "name": entry.get("name", ""),
        "created": entry.get("created"),
        "last_seen": entry.get("last_seen"),
        "online": sid in active,
        "seed": spec.get("seed"),
        "level": spec.get("level"),
        "targets": len(spec.get("targets", {})),
        "commands": state.get("commands", 0),
        "violations": state.get("violations", 0),
        "solved": state.get("solved", False),
        "solved_at": state.get("solved_at"),
    }


# --------------------------------------------------------------------------
# pty bridge
# --------------------------------------------------------------------------

class Terminal:
    def __init__(self, sid, ws, args):
        self.sid = sid
        self.ws = ws
        self.args = args
        self.pid = None
        self.fd = None
        self.closed = False

    def spawn(self):
        os.makedirs(LABS, exist_ok=True)
        pid, fd = pty.fork()
        if pid == 0:  # child
            env = dict(os.environ, TERM="xterm-256color", LANG=os.environ.get("LANG", "C.UTF-8"),
                       PYTHONUNBUFFERED="1")
            try:
                os.execve(sys.executable, [sys.executable, FSLAB, "--root", lab_root(self.sid)] + self.args, env)
            finally:
                os._exit(1)
        self.pid, self.fd = pid, fd
        os.set_blocking(fd, False)

    def resize(self, rows, cols):
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            except OSError:
                pass

    def write(self, data):
        if self.fd is not None:
            try:
                os.write(self.fd, data)
            except OSError:
                pass

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGHUP)
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                os.waitpid(self.pid, os.WNOHANG)
            except OSError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None
        if active.get(self.sid) is self:
            del active[self.sid]


async def ws_handler(request):
    sid = request.query.get("sid", "")
    if not SID_RE.match(sid):
        raise web.HTTPBadRequest(text="bad session id")

    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)

    # Build the fslab arguments for a NEW lab only; an existing lab is resumed.
    args = []
    is_new = not os.path.exists(os.path.join(lab_root(sid), ".lab", "spec.json"))
    if is_new:
        level = request.query.get("level") or DEFAULT_LEVEL
        seed = request.query.get("seed") or FIXED_SEED
        if level in ("1", "2", "3"):
            args += ["--level", level]
        if seed.isdigit():
            args += ["--seed", seed]
    elif request.query.get("new") == "1":
        args += ["--new"]
        level = request.query.get("level") or DEFAULT_LEVEL
        if level in ("1", "2", "3"):
            args += ["--level", level]
        seed = request.query.get("seed") or ""
        if seed.isdigit():
            args += ["--seed", seed]

    touch_session(sid, request.query.get("name", ""))

    old = active.get(sid)
    if old:  # a second tab for the same student: the old one goes
        try:
            await old.ws.send_json({"type": "replaced"})
        except Exception:
            pass
        old.close()

    term = Terminal(sid, ws, args)
    term.spawn()
    active[sid] = term
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(term.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            loop.remove_reader(term.fd)
            queue.put_nowait(None)
            return
        queue.put_nowait(data)

    loop.add_reader(term.fd, on_readable)

    async def pump():
        try:
            while True:
                data = await queue.get()
                if data is None:
                    await ws.send_json({"type": "exit"})
                    break
                await ws.send_bytes(data)
        except Exception:
            pass

    pump_task = asyncio.ensure_future(pump())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                term.write(msg.data)
            elif msg.type == WSMsgType.TEXT:
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if m.get("type") == "resize":
                    term.resize(int(m.get("rows", 24)), int(m.get("cols", 80)))
                elif m.get("type") == "input":
                    term.write(m.get("data", "").encode())
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        try:
            if term.fd is not None:
                loop.remove_reader(term.fd)
        except Exception:
            pass
        term.close()
        pump_task.cancel()
        touch_session(sid)
    return ws


# --------------------------------------------------------------------------
# JSON api
# --------------------------------------------------------------------------

async def api_me(request):
    sid = request.query.get("sid", "")
    if not SID_RE.match(sid):
        raise web.HTTPBadRequest(text="bad session id")
    entry = load_sessions().get(sid, {})
    return web.json_response(session_summary(sid, entry))


def require_teacher(request):
    if not TEACHER_KEY:
        raise web.HTTPForbidden(text="teacher dashboard disabled: set FSLAB_TEACHER_KEY")
    if not secrets.compare_digest(request.query.get("key", ""), TEACHER_KEY):
        raise web.HTTPForbidden(text="wrong key")


async def api_sessions(request):
    require_teacher(request)
    data = load_sessions()
    rows = [session_summary(sid, e) for sid, e in data.items()]
    rows.sort(key=lambda r: r.get("last_seen") or 0, reverse=True)
    return web.json_response(rows)


async def api_log(request):
    require_teacher(request)
    sid = request.match_info["sid"]
    if not SID_RE.match(sid):
        raise web.HTTPBadRequest(text="bad session id")
    path = os.path.join(lab_root(sid), ".lab", "history.log")
    try:
        with open(path) as f:
            text = f.read()
    except OSError:
        text = "(no log yet)"
    return web.Response(text=text, content_type="text/plain")


async def api_task(request):
    """The exercise spec of a student (teacher) - handy to see what they had to build."""
    require_teacher(request)
    sid = request.match_info["sid"]
    if not SID_RE.match(sid):
        raise web.HTTPBadRequest(text="bad session id")
    spec = read_json(os.path.join(lab_root(sid), ".lab", "spec.json")) or {}
    return web.json_response(spec)


async def index(request):
    return web.FileResponse(os.path.join(STATIC, "index.html"))


async def teacher(request):
    return web.FileResponse(os.path.join(STATIC, "teacher.html"))


def make_app():
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/teacher", teacher)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/teacher/sessions", api_sessions)
    app.router.add_get("/api/teacher/log/{sid}", api_log)
    app.router.add_get("/api/teacher/task/{sid}", api_task)
    app.router.add_static("/static", STATIC)
    return app


if __name__ == "__main__":
    if not os.path.exists(FSLAB):
        sys.exit("fslab.py not found next to web/: %s" % FSLAB)
    os.makedirs(LABS, exist_ok=True)
    port = int(os.environ.get("FSLAB_PORT", "8080"))
    print("fslab web on http://0.0.0.0:%d  (labs in %s, teacher dashboard %s)" % (
        port, LABS, "ON at /teacher?key=..." if TEACHER_KEY else "off"))
    web.run_app(make_app(), port=port, print=None)
