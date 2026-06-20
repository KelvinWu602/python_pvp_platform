import os
import json
import urllib.request
import urllib.error


class DBClient:
    """Simulator DB client that talks to the API server instead of RDS.

    Previously this opened a psycopg2 connection per Lambda invocation, which
    meant RDS connections scaled with Lambda concurrency and could exhaust
    max_connections. Now every operation is an HTTPS call to the API's
    /api/internal endpoints; the API's pg.Pool bounds the real RDS connection
    count. This also lets the Lambda run outside the VPC (no direct RDS need).

    Keeps the original method names/signatures (getCode, markPending,
    markComplete, markFailed, close) so handler.py is unchanged.

    Config via env:
      SIM_API_BASE_URL  - base URL of the API server, e.g. https://api.example.com
      SIM_API_TOKEN     - long-lived service-account session token (Bearer)
                          (see database/4. service-account.sql)
      SIM_API_TIMEOUT   - per-request timeout in seconds (default 10)
    """

    def __init__(self):
        base = os.environ.get('SIM_API_BASE_URL')
        token = os.environ.get('SIM_API_TOKEN')
        if not base:
            raise RuntimeError('SIM_API_BASE_URL is not set')
        if not token:
            raise RuntimeError('SIM_API_TOKEN is not set')
        self.base_url = base.rstrip('/')
        self.token = token
        self.timeout = float(os.environ.get('SIM_API_TIMEOUT', '10'))

    # -- HTTP helper --------------------------------------------------------
    def _request(self, method, path, body=None):
        """Make an authenticated request to the API. Returns the parsed JSON
        response (or None for empty bodies). Raises RuntimeError on non-2xx."""
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

    # -- code retrieval -----------------------------------------------------
    def getCode(self, code_id, file_path):
        """Fetch the code text for `code_id` from the API and write it to
        `file_path`. Raises RuntimeError if the code id does not exist (the
        API returns 404)."""
        result = self._request('GET', f'/api/internal/code/{code_id}')
        if not result or 'code' not in result:
            raise RuntimeError(f'code not found: {code_id}')

        parent = os.path.dirname(file_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(file_path, 'w') as f:
            f.write(result['code'])

    # -- job lifecycle ------------------------------------------------------
    def markPending(self, battle_id, simulation_id):
        """Create a fresh simulation_job row (status 'pending') via the API."""
        result = self._request('POST', '/api/internal/simulation-job/pending', {
            'battle_id': battle_id,
            'simulation_id': simulation_id,
        })
        if not result or 'simulation_id' not in result:
            raise RuntimeError(f'failed to markPending')
        return result['simulation_id']

    def markComplete(self, battle_id, simulation_id, winner_user_id,
                     loser_user_id, result, battle_video_reference):
        """Close the simulation_job as 'completed' via the API.

        `result` is a dict the game reports; score fields are optional:
            {"winner_score_gain": float, "loser_score_loss": float,
             "log": str}
        """
        result = result or {}
        self._request('POST', '/api/internal/simulation-job/complete', {
            'battle_id': battle_id,
            'simulation_id': simulation_id,
            'winner_user_id': winner_user_id,
            'loser_user_id': loser_user_id,
            'winner_score_gain': result.get('winner_score_gain', 0),
            'loser_score_loss': result.get('loser_score_loss', 0),
            'battle_video_reference': battle_video_reference,
            'execution_log': result.get('log'),
        })

    def markFailed(self, simulation_id, execution_log):
        """Mark the simulation_job 'failed' via the API, storing the error in
        execution_log."""
        self._request('POST', '/api/internal/simulation-job/failed', {
            'simulation_id': simulation_id,
            'execution_log': execution_log,
        })

    def close(self):
        """No persistent connection to close (kept for handler compatibility)."""
        pass
