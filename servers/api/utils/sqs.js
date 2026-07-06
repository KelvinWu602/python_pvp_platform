const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const QUEUE_URL = process.env.BATTLE_QUEUE_URL;

const client = new SQSClient({ region: REGION });

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
