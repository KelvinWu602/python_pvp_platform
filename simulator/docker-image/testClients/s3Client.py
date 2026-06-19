import os

from botocore.exceptions import ClientError


class S3Client:
    """Local test double for the production S3 client.

    No network, no boto3 client. Files are expected to already be staged on
    disk (e.g. by the test harness copying simulator/games/.../game.py into the
    working tree). The interface matches the production client so the handler
    is identical in both modes.
    """

    def __init__(self):
        # Nothing to set up: the local filesystem is the "bucket".
        pass

    def download(self, bucket_name, object_key, file_path):
        """bucket_name and object_key are ignored. If file_path already exists
        the "download" is a no-op; otherwise raise the same error boto3 raises
        when download_file is given a key that is not in the bucket (a 404
        ClientError), so the handler's error handling is exercised identically.
        """
        if os.path.exists(file_path):
            return

        raise ClientError(
            {
                'Error': {'Code': '404', 'Message': 'Not Found'},
                'ResponseMetadata': {'HTTPStatusCode': 404},
            },
            'HeadObject',
        )

    def upload(self, bucket_name, object_key, file_path):
        """No-op upload for tests. Returns the object key so the handler can
        still record a battle_video_reference."""
        return object_key
