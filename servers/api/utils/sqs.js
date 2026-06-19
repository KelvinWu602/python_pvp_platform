// SQS client for enqueuing battle simulation jobs.
//
// The API enqueues one message per battle run onto python-pvp-battle-queue
// (see AWS resource.md). The simulator Lambda is wired to this queue via an
// event source mapping (BatchSize=1) and consumes the message. SQS owns
// retries (visibility timeout) and dead-lettering, so the API's only job here
// is a single SendMessage after the battle row is committed.
//
// Config via env:
//   AWS_REGION        - region the queue lives in (e.g. ap-southeast-1)
//   BATTLE_QUEUE_URL  - full URL of python-pvp-battle-queue
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const QUEUE_URL = process.env.BATTLE_QUEUE_URL;

// Credentials resolve from the default provider chain (EC2 instance role, or
// AWS_* env vars for local dev) - nothing embedded here.
const client = new SQSClient({ region: REGION });

// enqueueBattle sends one battle job to the queue. `payload` is the event the
// simulator Lambda expects (battle_id, simulation_id, game_id, user/code ids).
// Throws if BATTLE_QUEUE_URL is unset or the send fails, so callers can react.
async function enqueueBattle(payload) {
  if (!QUEUE_URL) {
    throw new Error('BATTLE_QUEUE_URL is not configured');
  }

  const command = new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(payload),
  });

  return client.send(command);
}

module.exports = { enqueueBattle };
