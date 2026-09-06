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
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))

def stop(signum, _frame):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    inputs = [fd, sys.stdin.fileno()]
    while fd in inputs:
        ready, _, _ = select.select(inputs, [], [])
        for source in ready:
            try:
                data = os.read(source, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                inputs.remove(source)
                if source != fd:
                    stop(signal.SIGTERM, None)
                continue
            target = sys.stdout.fileno() if source == fd else fd
            while data:
                data = data[os.write(target, data):]
finally:
    os.close(fd)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
