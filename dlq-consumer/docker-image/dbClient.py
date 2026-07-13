import os
import json
import urllib.request
import urllib.error


class DBClient:
    """DLQ consumer API client.

    The DLQ consumer's only job is to mark stuck battles as failed via a single
    PUT /admin/battle/:id callback. Every other admin call in the platform
    (snapshot / competition fetch, attempt log) is the main Lambda's concern,
    not this consumer's.

    Config via env:
      LAMBDA_CALLBACK_BASE_URL - base URL of the API server, e.g. https://api.example.com
      LAMBDA_CALLBACK_TOKEN    - root Bearer token for callback auth
      LAMBDA_CALLBACK_TIMEOUT  - per-request timeout in seconds (default 10)
    """

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

    # -- battle callback (PUT) ---------------------------------------------
    def callback_battle(self, battle_id, *, infra_ok, input_ok,
                        winner_user_id=None, loser_user_id=None,
                        draw=None, video_reference=None):
        """Write battle result via the API.

        PUT /admin/battle/:id → sets infra_ok/input_ok + updates battle row.
        Called by the DLQ consumer with infra_ok=false to mark a battle as
        infra-failed. The API uses WHERE infra_ok IS NULL, so a late DLQ
        retry cannot overwrite a battle that the main Lambda already
        completed successfully.
        """
        body = {
            'infra_ok': infra_ok,
            'input_ok': input_ok,
            'draw': draw,
            'winner_user_id': winner_user_id,
            'loser_user_id': loser_user_id,
            'video_reference': video_reference,
        }
        self._request('PUT', f'/admin/battle/{battle_id}', body)

    def close(self):
        pass
