# Runs as root (python3 -I, so nothing in the worker-writable cwd is importable) in the sandbox
# before every exec, with the workspace as cwd (see SbxSandbox.exec).
# argv: [--chmod] <dep dir>...
# The workspace of a Windows host is an NTFS folder over virtiofs, which (1) cannot hold symlinks,
# so `npm ci` and `uv sync` fail, and (2) shows every file as executable, so linters flag EXE002.
# (1): bind a sandbox-local dir over each dependency dir (top level only). A sandbox restart drops
#      bind mounts, hence the re-check on every exec. The host sees an empty dir.
# (2): with --chmod (Windows hosts only), clear the exec bits of files that have no shebang.
import ctypes, os, sys

args = sys.argv[1:]
chmod = args[:1] == ['--chmod']
deps = args[1:] if chmod else args
ws = os.getcwd()
libc = ctypes.CDLL(None, use_errno=True)

def bound(dst, src):
    # a bind mount shows the source dir's inode and device at dst
    try:
        return os.stat(dst)[1:3] == os.stat(src)[1:3]
    except FileNotFoundError:
        return False

for d in deps:
    dst, src = os.path.join(ws, d), os.path.join('/home/agent/.sf-deps', d)
    if bound(dst, src):
        continue
    os.makedirs(src, exist_ok=True)
    os.makedirs(dst, exist_ok=True)
    os.chown(src, 1000, 1000)
    if libc.mount(src.encode(), dst.encode(), None, 4096, None) != 0:  # 4096 = MS_BIND
        sys.exit(f'sf prep: bind {dst}: {os.strerror(ctypes.get_errno())}')

if chmod:
    # shortcut: walks the whole workspace on every exec; fine for PR-sized repos, cache by mtime if it gets slow.
    for root, dirs, files in os.walk(ws):
        dirs[:] = [x for x in dirs if x not in ('.git', *deps)]
        for f in files:
            try:
                fd = os.open(os.path.join(root, f), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except OSError:
                continue  # a symlink, or vanished
            try:
                st = os.fstat(fd)
                if (st.st_mode & 0o170000) == 0o100000 and st.st_mode & 0o111 and os.read(fd, 2) != b'#!':
                    os.fchmod(fd, st.st_mode & 0o7666)
            finally:
                os.close(fd)
