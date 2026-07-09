import os
import json
import urllib.request
import urllib.error


class DBClient:
    """Simulator API client. Every operation is an HTTPS call to the API server.

    Log fields larger than _MAX_LOG_LENGTH are trimmed before sending to avoid
    triggering Express's body-parser size limit on the API side.
    """

    _MAX_LOG_LENGTH = 10 * 1024

    @staticmethod
    def _trim(text):
        if text and len(text) > DBClient._MAX_LOG_LENGTH:
            return text[:DBClient._MAX_LOG_LENGTH] + '\n... [truncated]'
        return text

    def __init__(self):
        base = os.environ.get('LAMBDA_CALLBACK_BASE_URL')
        token = os.environ.get('LAMBDA_CALLBACK_TOKEN')
        if not base:
            raise RuntimeError('LAMBDA_CALLBACK_BASE_URL is not set')
        if not token:
            raise RuntimeError('LAMBDA_CALLBACK_TOKEN is not set')
        self.base_url = base.rstrip('/')
        self.token = token
        self.timeout = float(os.environ.get('LAMBDA_CALLBACK_TIMEOUT', '10'))

    # -- HTTP helper --------------------------------------------------------
    def _request(self, method, path, body=None):
        url = f'{self.base_url}{path}'
        data = None
        headers = {'Authorization': f'Bearer {self.token}'}
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')
            raise RuntimeError(f'{method} {path} failed: {e.code} {detail}')
        except urllib.error.URLError as e:
            raise RuntimeError(f'{method} {path} failed: {e.reason}')

    # -- snapshot code retrieval -------------------------------------------
    def fetch_snapshot(self, snapshot_id):
        """Fetch snapshot code text from the API.

        GET /admin/snapshot/:id → {"code": "..."}
        """
        result = self._request('GET', f'/admin/snapshot/{snapshot_id}')
        if not result or 'code' not in result:
            raise RuntimeError(f'snapshot not found: {snapshot_id}')
        return result['code']

    # -- competition retrieval ---------------------------------------------
    def fetch_competition(self, competition_id):
        """Fetch competition from the API (root bypass on user route).

        GET /competition/:id → competition row dict
        """
        result = self._request('GET', f'/competition/{competition_id}')
        if not result or 'game_reference' not in result:
            raise RuntimeError(f'competition not found: {competition_id}')
        return result

    # -- battle attempt log (PUT) ------------------------------------------
    def log_attempt(self, battle_id, lambda_request_id):
        """Record that the Lambda started processing this battle.

        POST /admin/battle-attempt/:id → INSERTs execution_log with NULL end_time_utc.
        If the battle already completed, this is a no-op (idempotent).
        """
        self._request('POST', f'/admin/battle-attempt/{battle_id}', {
            'lambda_request_id': lambda_request_id
        })

    # -- battle callback (PUT) ---------------------------------------------
    def callback_battle(self, battle_id, *, infra_ok, input_ok,
                        winner_user_id=None, loser_user_id=None,
                        draw=None, video_reference=None,
                        a_stdout_log=None, a_stderr_log=None,
                        b_stdout_log=None, b_stderr_log=None):
        """Write battle result via the API.

        PUT /admin/battle/:id → sets infra_ok/input_ok + updates battle row.
        Called by the main Lambda (infra_ok=true) or DLQ consumer (infra_ok=false).
        The API uses WHERE infra_ok IS NULL, so a late retry won't overwrite.
        """
        body = {
            'infra_ok': infra_ok,
            'input_ok': input_ok,
            'draw': draw,
            'winner_user_id': winner_user_id,
            'loser_user_id': loser_user_id,
            'video_reference': video_reference,
            'a_stdout_log': self._trim(a_stdout_log),
            'a_stderr_log': self._trim(a_stderr_log),
            'b_stdout_log': self._trim(b_stdout_log),
            'b_stderr_log': self._trim(b_stderr_log),
        }
        self._request('PUT', f'/admin/battle/{battle_id}', body)

    def close(self):
        pass
