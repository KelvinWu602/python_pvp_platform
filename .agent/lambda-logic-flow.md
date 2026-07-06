# Lambda Logic Flow

Single Lambda handles all battles (test = vs NPC, battle = vs user). Event-source mapped to one SQS queue.

**The Lambda never queries the DB directly.** All data access goes through the API at `/admin/*` with a root Bearer token (`LAMBDA_CALLBACK_TOKEN`).

---

## Input (from SQS)

```json
{
  "battle_id": "uuid",
  "competition_id": "uuid",
  "is_test": false,
  "a_user_id": "uuid",
  "b_user_id": "uuid",
  "a_snapshot_id": "uuid",
  "b_snapshot_id": "uuid"
}
```

---

## API Endpoints the Lambda Calls

| Method | Path | Route | Purpose |
|--------|------|-------|---------|
| GET | /competition/:id | User (root bypass) | Fetch competition (game_reference, helper_reference, manifest_reference for S3) |
| GET | /admin/snapshot/:id | Root | Fetch snapshot code text |
| PUT | /admin/battle/:id | Root | Write result + execution_log |

All authenticated with `Authorization: Bearer <LAMBDA_CALLBACK_TOKEN>`. Root token bypasses user-route role checks.

---

## Handler

```
handler(event):
    msg = parse(event.Records[0].body)
    lambda_request_id = context.log_stream_name
    start_time = now()

    try:
        # ─── SETUP (infra) ──────────────────────────────
        # Fetch both code snapshots via API
        a_resp = http.get("/admin/snapshot/" + msg.a_snapshot_id)
        if a_resp.status != 200: raise InfraError("Failed to fetch snapshot A")
        b_resp = http.get("/admin/snapshot/" + msg.b_snapshot_id)
        if b_resp.status != 200: raise InfraError("Failed to fetch snapshot B")

        # Fetch competition (contains S3 keys for game engine)
        comp_resp = http.get("/admin/competition/" + msg.competition_id)
        if comp_resp.status != 200: raise InfraError("Failed to fetch competition")
        comp = comp_resp.body

        # Download game files from S3 (Lambda has S3 permissions via IAM role)
        game_engine = download_from_s3(comp.game_reference)
        helper = download_from_s3(comp.helper_reference)
        manifest = download_from_s3(comp.manifest_reference)

        # ─── EXECUTION (user code) ──────────────────────
        try:
            result = run_game(a_resp.body.code, b_resp.body.code, game_engine)

            callback_body = {
                "infra_ok": true,
                "input_ok": result.input_clean,
                "draw": result.is_draw,
                "winner_user_id": result.winner_id,
                "loser_user_id": result.loser_id,
                "video_reference": result.video_s3_key,
                "sqs_input": event.Records[0].body,
                "lambda_request_id": lambda_request_id,
                "start_time_utc": start_time.isoformat()
            }
        except UserCodeError as e:
            callback_body = {
                "infra_ok": true,
                "input_ok": false,
                "draw": e.is_draw,
                "winner_user_id": e.winner_id,
                "loser_user_id": e.loser_id,
                "video_reference": null,
                "sqs_input": event.Records[0].body,
                "lambda_request_id": lambda_request_id,
                "start_time_utc": start_time.isoformat()
            }

    except InfraError as e:
        callback_body = {
            "infra_ok": false,
            "input_ok": false,
            "draw": null,
            "winner_user_id": null,
            "loser_user_id": null,
            "video_reference": null,
            "sqs_input": event.Records[0].body,
            "lambda_request_id": lambda_request_id,
            "start_time_utc": start_time.isoformat()
        }

    # ─── CALLBACK ──────────────────────────────────────
    http.put("/admin/battle/" + msg.battle_id, callback_body, {
        "Authorization": "Bearer " + env.LAMBDA_CALLBACK_TOKEN
    })
```

---

## Error Boundary

| Exception source | infra_ok | input_ok | winner/loser |
|---|---|---|---|
| SETUP (API/S3/network) | false | false | null |
| EXECUTION — both codes clean | true | true | set by game |
| EXECUTION — one code crashes | true | false | surviving player wins |
| EXECUTION — both crash | true | false | null (draw) |
| Lambda timeout | no callback → SQS retries → DLQ |

---

## DLQ Consumer

Picks up from `python-pvp-battle-queue-dlq` when maxReceiveCount exhausted.

The DLQ consumer also calls the API — the same `PUT /admin/battle/:id` with `infra_ok = false, input_ok = false`:

```
handler(event):
    msg = parse(event.Records[0].body)
    http.put("/admin/battle/" + msg.battle_id, {
        "infra_ok": false,
        "input_ok": false,
        "sqs_input": event.Records[0].body,
        "lambda_request_id": "dlq/exhausted",
        "start_time_utc": now().isoformat()
    }, {
        "Authorization": "Bearer " + env.LAMBDA_CALLBACK_TOKEN
    })
```

The API handler skips the UPDATE if `infra_ok` is already set (late retry succeeded):

```sql
UPDATE app.battle
SET infra_ok = false, input_ok = false, updated_at_utc = now()
WHERE id = $1 AND infra_ok IS NULL;
```

---

## SQS Topology

```
POST /battle → enqueueBattle → python-pvp-battle-queue
                                  ├── maxReceiveCount (3)
                                  ├── visibility timeout (6 min)
                                  └── DLQ: python-pvp-battle-queue-dlq
                                          └── DLQ Consumer Lambda
```
