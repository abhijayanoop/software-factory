# Runs as root in the sandbox before every exec, with the workspace as cwd (see SbxSandbox.exec).
# The workspace is a Windows host folder over virtiofs, which (1) cannot hold symlinks, so `npm ci`
# and `uv sync` fail, and (2) shows every file as executable, so linters flag EXE002.
# (1): bind a sandbox-local dir over each dependency dir in argv (node_modules, .venv). A sandbox
#      restart drops bind mounts, hence the re-check on every exec. The host sees an empty dir.
# (2): clear the exec bits of files that have no shebang.
import ctypes, os, sys

ws = os.getcwd()
mounted = {line.split()[4] for line in open('/proc/self/mountinfo')}
libc = ctypes.CDLL(None, use_errno=True)
for d in sys.argv[1:]:
    dst, src = os.path.join(ws, d), os.path.join('/home/agent/.sf-deps', d)
    if dst in mounted:
        continue
    os.makedirs(src, exist_ok=True)
    os.makedirs(dst, exist_ok=True)
    os.chown(src, 1000, 1000)
    if libc.mount(src.encode(), dst.encode(), None, 4096, None) != 0:  # 4096 = MS_BIND
        sys.exit(f'sf prep: bind {dst}: {os.strerror(ctypes.get_errno())}')

# shortcut: walks the whole workspace on every exec; fine for PR-sized repos, cache by mtime if it gets slow.
for root, dirs, files in os.walk(ws):
    dirs[:] = [x for x in dirs if x not in ('.git', *sys.argv[1:])]
    for f in files:
        p = os.path.join(root, f)
        st = os.lstat(p)
        if not (st.st_mode & 0o111) or not os.path.isfile(p) or os.path.islink(p):
            continue
        with open(p, 'rb') as fh:
            if fh.read(2) == b'#!':
                continue
        os.chmod(p, st.st_mode & ~0o111)
