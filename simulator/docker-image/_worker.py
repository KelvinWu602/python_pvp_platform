import sys
import json
import os
import resource


def main():
    line = sys.stdin.readline()
    if not line:
        return
    payload = json.loads(line)

    helper_dir = payload.get('helper_dir', '')
    if helper_dir:
        sys.path.insert(0, helper_dir)

    ipc_fd = payload.get('ipc_fd', 4)
    ipc_out = os.fdopen(ipc_fd, 'w')

    # exec() compiles and runs the user's Python code in a fresh dict namespace.
    # This is equivalent to executing the code at module level. After exec(),
    # any functions/classes defined by the user are in `namespace`.
    namespace = {}
    try:
        exec(payload['user_code'], namespace)
    except SyntaxError as e:
        print(f'SyntaxError: {str(e)}', file=sys.stderr)
        ipc_out.write(json.dumps({'ok': False, 'error': f'user provided code has syntax error: {str(e)}'}) + '\n')
        ipc_out.flush()
        return
    except Exception as e:
        print(f'Exception: {str(e)}', file=sys.stderr)
        ipc_out.write(json.dumps({'ok': False, 'error': f'exec error: {e}'}) + '\n')
        ipc_out.flush()
        return

    update_func = namespace.get('update')

    # If the user forgot to define update(), tell the parent immediately
    # and exit. The parent will raise UserCodeError.
    if not update_func:
        print(f'Exception: update() function not found', file=sys.stderr)
        ipc_out.write(json.dumps({'ok': False, 'error': 'update() function not found'}) + '\n')
        ipc_out.flush()
        return

    # Acknowledge success. The parent's _spawn() waits for this before
    # returning the worker to the game loop.
    ipc_out.write(json.dumps({'ok': True}) + '\n')
    ipc_out.flush()

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
            ipc_out.write(json.dumps({
                'ok': True,
                'controls': result,
            }) + '\n')
        except Exception as e:
            print(f'Exception: {str(e)}', file=sys.stderr)
            ipc_out.write(json.dumps({'ok': False, 'error': str(e)}) + '\n')
        # Flush every frame so the parent receives the response immediately.
        # Without flush(), output buffers and the parent's select() would
        # timeout waiting for data that's stuck in our buffer.
        ipc_out.flush()


if __name__ == '__main__':
    main()
