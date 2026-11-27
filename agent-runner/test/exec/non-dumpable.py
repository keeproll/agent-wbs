import ctypes
import json
import os
import subprocess
import sys
import time

mode = sys.argv[1]
if mode == 'parent':
    child = subprocess.Popen([sys.executable, __file__, 'detached'], stdout=subprocess.PIPE, text=True)
    print(child.stdout.readline().strip(), flush=True)
    child.wait()
else:
    if mode == 'detached':
        os.setsid()
    PR_SET_DUMPABLE = 4
    assert ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0
    print(json.dumps({'pid': os.getpid(), 'ppid': os.getppid()}), flush=True)
    time.sleep(60)
