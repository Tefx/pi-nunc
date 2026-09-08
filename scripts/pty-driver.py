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

pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
rows = int(os.environ.get("NUNC_PTY_ROWS", "40"))
cols = int(os.environ.get("NUNC_PTY_COLS", "140"))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.set_blocking(fd, False)

def stop(signum, _frame):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    inputs = [fd, sys.stdin.fileno()]
    pending = bytearray()
    while fd in inputs:
        # A blocking PTY write can deadlock against Pi rendering the previous
        # large message. Drain terminal output while forwarding queued input.
        readers = [source for source in inputs if source == fd or len(pending) < 1048576]
        ready, writable, _ = select.select(readers, [fd] if pending else [], [])
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
    os.close(fd)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
