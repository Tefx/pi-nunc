# purpose: Drive the actual stock Pi TUI through a real PTY for tracked observations.
# usage: python3 scripts/pty-driver.py <node> <stock-cli> [stock-cli args...]
# effects: One child process and PTY; stdin bytes forwarded, ANSI stdout captured; signals terminate child.
# requires: Python 3 stdlib, POSIX PTY, already installed target Node/Pi.
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid = None
pending_signal = None
kill_at = None

def stop(signum, _frame):
    global kill_at, pending_signal
    if pid is None:
        pending_signal = signum
        return
    try:
        os.killpg(pid, signum)
    except (ProcessLookupError, PermissionError):
        pass
    if kill_at is None:
        kill_at = time.monotonic() + 1

def escalate():
    if kill_at is not None and time.monotonic() >= kill_at:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
pid, fd = pty.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    os.execv(sys.argv[1], sys.argv[1:])
if pending_signal is not None:
    stop(pending_signal, None)
try:
    rows = int(os.environ.get("NUNC_PTY_ROWS", "40"))
    cols = int(os.environ.get("NUNC_PTY_COLS", "140"))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.set_blocking(fd, False)
    inputs = [fd, sys.stdin.fileno()]
    pending = bytearray()
    while fd in inputs:
        # A blocking PTY write can deadlock against Pi rendering the previous
        # large message. Drain terminal output while forwarding queued input.
        readers = [source for source in inputs if source == fd or len(pending) < 1048576]
        ready, writable, _ = select.select(readers, [fd] if pending else [], [], 0.1)
        escalate()
        for source in ready:
            try:
                data = os.read(source, 65536)
            except BlockingIOError:
                continue
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                inputs.remove(source)
                if source != fd:
                    stop(signal.SIGTERM, None)
                continue
            if source != fd:
                pending.extend(data)
                continue
            while data:
                data = data[os.write(sys.stdout.fileno(), data):]
        if fd in inputs and fd in writable:
            try:
                written = os.write(fd, pending[:65536])
                del pending[:written]
            except BlockingIOError:
                pass
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                inputs.remove(fd)
finally:
    # Reap a normal leader first so a clean group needs no grace delay.
    reaped, status = 0, 0
    try:
        reaped, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        reaped = pid
    try:
        os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + 0.1
        while True:
            os.killpg(pid, 0)
            if time.monotonic() >= deadline:
                os.killpg(pid, signal.SIGKILL)
                # Darwin may report EPERM for a zombie-only process group.
                deadline = time.monotonic() + 0.1
                while time.monotonic() < deadline:
                    os.killpg(pid, 0)
                    time.sleep(0.01)
                break
            time.sleep(0.01)
    except (ProcessLookupError, PermissionError):
        pass
    finally:
        try:
            if not reaped:
                try:
                    _, status = os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
        finally:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
