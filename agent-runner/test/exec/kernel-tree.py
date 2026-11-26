"""유료 CLI 대신 실제 fork·setsid·nohup을 사용하는 커널 시험용 프로그램."""
import json
import os
import signal
import subprocess
import sys
import time

mode, path = sys.argv[1:3]


def leaf(role):
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    os.close(null)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    # 메모리와 CPU 측정값이 실제 작업을 반영하도록 작은 부하만 만든다.
    memory = bytearray(2 * 1024 * 1024)
    end = time.monotonic() + 0.03
    while time.monotonic() < end:
        memory[0] = (memory[0] + 1) % 256
    with open('/proc/self/stat', encoding='utf8') as source:
        fields = source.read().rsplit(')', 1)[1].split()
    row = dict(pid=os.getpid(), ppid=os.getppid(), pgid=os.getpgrp(),
               sid=os.getsid(0), role=role,
               marked="AWBS_LAUNCH_ID" in os.environ,
               hup_ignored=signal.getsignal(signal.SIGHUP) == signal.SIG_IGN,
               start_time=fields[19],
               cpu_seconds=(int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK'),
               rss_bytes=int(fields[21]) * os.sysconf('SC_PAGESIZE'))
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.write(fd, (json.dumps(row) + "\n").encode())
    os.close(fd)
    while True:
        signal.pause()


if mode == "leaf":
    leaf(sys.argv[3])


def start(kind):
    if kind == "nohup":
        subprocess.Popen(["/usr/bin/nohup", sys.executable, __file__, "leaf", path, kind],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        return
    pid = os.fork()
    if pid:
        if kind in ("double-fork", "scrub"):
            os.waitpid(pid, 0)
        return
    if kind == "tree":
        if os.fork() == 0:
            leaf("grandchild")
        leaf("child")
    os.setsid()
    if kind in ("double-fork", "scrub"):
        if os.fork():
            os._exit(0)
        if kind == "scrub":
            env = dict(os.environ)
            env.pop("AWBS_LAUNCH_ID", None)
            os.execve(sys.executable, [sys.executable, __file__, "leaf", path, kind], env)
    leaf(kind)


kinds = ["tree", "setsid", "nohup", "double-fork", "scrub"] if mode == "all" else [mode]
for kind in kinds:
    start(kind)
expected = sum(2 if kind == "tree" else 1 for kind in kinds)
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        with open(path, encoding="utf8") as records:
            if len(records.readlines()) == expected:
                print("ready", flush=True)
                if "--hold" in sys.argv:
                    while True:
                        signal.pause()
                sys.exit(0)
    except FileNotFoundError:
        pass
    time.sleep(0.01)
raise RuntimeError("자손 프로세스 준비 시간 초과")
