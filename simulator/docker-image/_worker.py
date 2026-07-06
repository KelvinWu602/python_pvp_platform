import sys
import json


def main():
    # ── Startup handshake ──────────────────────────────────────────────
    #
    # The parent (sandbox.py) spawns us with subprocess.Popen(stdin=PIPE, stdout=PIPE).
    # Our stdin/stdout are connected to pipe objects in the parent process:
    #
    #   We read from:  sys.stdin   ← data written by parent to self._proc.stdin
    #   We write to:   sys.stdout  → data read  by parent from self._proc.stdout
    #
    # The first message from the parent contains the user's code and (optionally)
    # a helper directory path. We exec() the user code into a namespace, then
    # look for an update() function.

    # sys.stdin.readline() blocks until a complete line (ending with \n) arrives
    # through the pipe. If the pipe is closed (parent crashed), we get "" and exit.
    line = sys.stdin.readline()
    if not line:
        return
    payload = json.loads(line)

    # If the game defines a helper module, add its directory to sys.path so the
    # user code can `import helper`. The parent downloads the helper from S3 and
    # writes it to /tmp/sandbox/helper.py before spawning us.
    helper_dir = payload.get('helper_dir', '')
    if helper_dir:
        sys.path.insert(0, helper_dir)

    # exec() compiles and runs the user's Python code in a fresh dict namespace.
    # This is equivalent to executing the code at module level. After exec(),
    # any functions/classes defined by the user are in `namespace`.
    #
    # Security note: we rely on the OS-level rlimits (CPU, memory, no subprocesses,
    # no file writes) set by the parent's preexec_fn. exec() itself is not sandboxed
    # — a determined attacker could still access builtins, import modules, etc.
    # The rlimits prevent abuse at the kernel level.
    namespace = {}
    exec(payload['user_code'], namespace)
    update_func = namespace.get('update')

    # If the user forgot to define update(), tell the parent immediately
    # and exit. The parent will raise UserCodeError.
    if not update_func:
        sys.stdout.write(json.dumps({'ok': False, 'error': 'update() function not found'}) + '\n')
        sys.stdout.flush()
        return

    # Acknowledge success. The parent's _spawn() waits for this before
    # returning the worker to the game loop.
    sys.stdout.write(json.dumps({'ok': True}) + '\n')
    sys.stdout.flush()

    # ── Per-frame game loop ────────────────────────────────────────────
    #
    # After startup, we enter an infinite loop reading one line per game frame.
    # The parent sends one JSON line per frame:
    #
    #   {"game_states": {...}}                                           ← TODO: update game engine's simulate() to pass this
    #
    # We call update(game_states) and write back the result:
    #
    #   {"ok": true, "controls": { ... }}
    #
    # The parent enforces a per-frame timeout (1s) via select.select(). If we
    # take too long (e.g. infinite loop), the parent raises TimeoutError on its
    # side and closes us. Our output on this frame is simply lost.

    # sys.stdin is iterable over lines. Each iteration blocks on readline().
    # When the parent closes the pipe (self._proc.stdin.close() or process exit),
    # readline() returns "" and the loop ends naturally.
    for line in sys.stdin:
        if not line:
            break
        try:
            frame = json.loads(line)
            result = update_func(frame['game_states'])
            sys.stdout.write(json.dumps({
                'ok': True,
                'controls': result,
            }) + '\n')
        except Exception as e:
            sys.stdout.write(json.dumps({'ok': False, 'error': str(e)}) + '\n')
        # Flush every frame so the parent receives the response immediately.
        # Without flush(), output buffers and the parent's select() would
        # timeout waiting for data that's stuck in our buffer.
        sys.stdout.flush()


if __name__ == '__main__':
    main()
