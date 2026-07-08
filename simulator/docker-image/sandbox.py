import os
import json
import subprocess
import resource
import select


class UserCodeError(Exception):
    """Raised when user-provided code fails (syntax error, runtime error, timeout)."""


HERE = os.path.dirname(os.path.abspath(__file__))


class PlayerWorker:
    """Runs a player's strategy in a sandboxed subprocess.

    Each worker is a separate Python process with kernel-enforced resource limits
    (CPU=1s, no subprocesses, no file writes, 64 MB memory). The parent
    communicates with it via stdin/stdout JSON messages:

      Parent → Child:  {"game_states": {...}}                         ← TODO: update game engine's simulate() to pass this
      Child  → Parent: {"ok": true, "controls": {...}}
                        {"ok": false, "error": "..."}

    Any failure (crash, timeout, user code error) raises UserCodeError.
    The caller (handler.py) catches it and records input_ok=false.
    """

    _STRIPPED_ENV_KEYS = frozenset({
        'S3_BUCKET',
        'LAMBDA_CALLBACK_BASE_URL',
        'LAMBDA_CALLBACK_TOKEN',
        'LAMBDA_CALLBACK_TIMEOUT',
    })
    _WORKER_PATH = os.path.join(HERE, '_worker.py')
    _RLIMITS = {
        resource.RLIMIT_CPU: (1, 1),
        resource.RLIMIT_NPROC: (0, 0),
        resource.RLIMIT_FSIZE: (0, 0),
        resource.RLIMIT_AS: (64 * 1024 * 1024, 64 * 1024 * 1024),
    }

    def __init__(self, user_code, helper_dir=None):
        self._user_code = user_code
        self._helper_dir = helper_dir
        self._proc = None
        self._spawn()

    # ── lifecycle ──────────────────────────────────────────────────────────

    def _spawn(self):
        # subprocess.Popen starts a new OS-level process running `python3 _worker.py`.
        # It does NOT wait for the child to finish — both processes run concurrently.
        #
        # stdin=PIPE, stdout=PIPE, stderr=PIPE:
        #   Instead of the child reading from the keyboard (stdin) or writing to
        #   the terminal (stdout), we create "pipe" objects — think of them as
        #   one-way communication tubes:
        #
        #     self._proc.stdin  (a pipe writable by PARENT, readable by CHILD)
        #     self._proc.stdout (a pipe writable by CHILD, readable by PARENT)
        #     self._proc.stderr (a pipe writable by CHILD, readable by PARENT)
        #
        #   Parent writes to  self._proc.stdin   ──► Child reads from sys.stdin
        #   Child  writes to  sys.stdout         ──► Parent reads from self._proc.stdout
        #
        # preexec_fn is a function that runs in the CHILD process just after fork()
        # but before exec(). We use it to set resource limits (rlimits) that the
        # kernel enforces — the child cannot escape them.
        self._proc = subprocess.Popen(
            ['python3', self._WORKER_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=self._apply_sandbox,
            env={k: v for k, v in os.environ.items() if k not in self._STRIPPED_ENV_KEYS},
        )

        # Send the user's code and helper path to the child via its stdin pipe.
        # The child reads this with sys.stdin.readline() in _worker.py.
        startup = {'user_code': self._user_code}
        if self._helper_dir:
            startup['helper_dir'] = self._helper_dir
        self._write(startup)

        # Wait for the child to confirm it successfully loaded the user's code.
        # The child writes {"ok": true} to its stdout after exec() succeeds.
        # If the user's code has a syntax error or doesn't define update(),
        # the child writes {"ok": false, "error": "..."} instead.
        resp = self._read(timeout=5.0)
        if not resp.get('ok'):
            raise UserCodeError(f'worker startup failed: {resp.get("error", "unknown")}')

    @staticmethod
    def _apply_rlimits():
        for rlim, value in PlayerWorker._RLIMITS.items():
            try:
                resource.setrlimit(rlim, value)
            except (resource.error, ValueError):
                pass

    @staticmethod
    def _apply_sandbox():
        PlayerWorker._apply_rlimits()

    def close(self):
        if self._proc:
            # Send SIGKILL to the child process. The kernel terminates it
            # immediately — no cleanup, no signal handler.
            self._proc.kill()
            # Wait for the child to actually exit (reap the zombie).
            # Without wait(), the child becomes a zombie process until
            # the parent (this Lambda) exits.
            self._proc.wait()
            self._proc = None

    # ── IPC helpers (parent ↔ child via pipes) ──────────────────────────────
    #
    # The parent and child communicate by writing/reading JSON lines through
    # two OS pipes:
    #
    #   Parent                        Child
    #   ──────────────► self._proc.stdin  ──► sys.stdin (readline)
    #   self._proc.stdout ◄── sys.stdout  ◄──────────────
    #
    # Each message is one JSON object followed by a newline ("\n"). This is
    # called "newline-delimited JSON" (NDJSON) — a simple framing protocol.
    # The newline lets the receiver know where one message ends and the next
    # begins.
    #
    # Example:
    #   Parent writes:   {"game_states": {...}}\n
    #   Child reads:     line = sys.stdin.readline()  → JSON string
    #   Child writes:    {"ok": true, "controls": {...}}\n
    #   Parent reads:    line = self._proc.stdout.readline() → JSON string

    def _write(self, data):
        # Convert the dict to a JSON string and write it into the child's
        # stdin pipe. The child's sys.stdin.readline() will receive this
        # as a complete line (up to the \n).
        # 
        # json.dumps(..., default=str) handles non-serializable values
        # like numpy arrays by converting them to strings.
        self._proc.stdin.write((json.dumps(data, default=str) + '\n').encode('utf-8'))
        # Flush ensures the data actually leaves the parent process's
        # buffer and travels through the pipe to the child immediately.
        # Without flush(), the data could stay buffered indefinitely.
        self._proc.stdin.flush()

    def _read(self, timeout=1.0):
        # select.select() checks if the child's stdout pipe has data
        # available to read, without blocking forever if it doesn't.
        #
        #   r = [self._proc.stdout]  → data is ready to read
        #   r = []                   → timeout expired, no data
        #
        # This is the per-frame timeout mechanism. If the child is stuck
        # in an infinite loop, its stdout pipe stays empty, select()
        # returns after 1s, and we raise TimeoutError.
        r, _, _ = select.select([self._proc.stdout], [], [], timeout)
        if not r:
            raise TimeoutError('worker did not respond in time')

        # readline() blocks until it sees a \n or the pipe closes.
        # Since select() already confirmed data exists, this usually
        # returns immediately. But if the child crashed after select()
        # returned (race condition), readline() returns empty string.
        line = self._proc.stdout.readline()
        if not line:
            # Empty line means EOF — the child's stdout pipe was closed,
            # which happens when the child process terminates.
            raise BrokenPipeError('worker process died')

        # Parse the JSON line back into a dict.
        return json.loads(line)

    # ── public API ─────────────────────────────────────────────────────────
    #
    # The game calls this like a regular function:
    #     controls = worker(game_states)
    #
    # Under the hood, it writes game_states into the child's stdin pipe,
    # waits for the child to compute the result, and reads controls back
    # from the child's stdout pipe. The game has no idea IPC is happening.

    def __call__(self, game_states):
        try:
            self._write({'game_states': game_states})
            resp = self._read(timeout=1.0)
            if resp.get('ok'):
                return resp['controls']
            raise UserCodeError(resp.get('error', 'unknown'))
        except Exception as e:
            raise UserCodeError(str(e))

    def __del__(self):
        self.close()
