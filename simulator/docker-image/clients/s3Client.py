import os

import boto3


class S3Client:
    """Production S3 client for the simulator.

    Bucket: python-pvp-store (see simulator/design.md). Layout:
        game/<game_id>/game.py        game definitions
        output/<simulation_id>.mp4     rendered replays (written by us)

    Player strategy code is NOT stored in S3. It lives in the app.code table
    in RDS and is fetched by the DB client (dbClient.getCode), so this client
    only handles game definitions (download) and replay videos (upload).

    Authentication
    --------------
    No access keys are embedded here. The Lambda function assumes its
    execution role and boto3 picks the credentials up automatically from the
    standard provider chain (the AWS_* env vars Lambda injects). The role only
    needs s3:GetObject / s3:PutObject on arn:aws:s3:::python-pvp-store/*.

    The function runs in the AWS-managed network (no VPC) and reaches S3 over
    the public internet. The `python-pvp-to-s3` gateway endpoint is no longer
    needed since the Lambda is not in `python-pvp-vpc`.

    The handler passes the bucket name explicitly on every call so the path
    convention lives in design.md / the handler rather than being hidden here.
    """

    def __init__(self):
        # boto3 resolves credentials from the Lambda execution role via the
        # default provider chain; nothing to configure here.
        self.s3 = boto3.client('s3')

    def download(self, bucket_name, object_key, file_path):
        """Download object_key from bucket_name to file_path, creating any
        missing parent directories. Raises botocore ClientError (404) if the
        object key does not exist."""
        parent = os.path.dirname(file_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.s3.download_file(bucket_name, object_key, file_path)

    def upload(self, bucket_name, object_key, file_path):
        """Upload the local file at file_path to object_key in bucket_name.
        Returns the stored object key (recorded as battle_video_reference)."""
        self.s3.upload_file(file_path, bucket_name, object_key)
        return object_key
