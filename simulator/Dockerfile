# AWS Lambda container image for the python-pvp simulator.
#
# Build context is simulator/ (this directory); the application lives under
# docker-image/. Build & push, e.g.:
#   docker build -t python-pvp-simulator .
#   docker tag python-pvp-simulator <acct>.dkr.ecr.<region>.amazonaws.com/python-pvp-simulator
#   docker push <acct>.dkr.ecr.<region>.amazonaws.com/python-pvp-simulator
#
# Runtime env vars (see clients/):
#   RUNNING_MODE     'production' (default) or 'test'
#   S3_BUCKET        defaults to python-pvp-store
#   SIM_API_BASE_URL base URL of the API server (DB access goes through it)
#   SIM_API_TOKEN    long-lived service-account session token (Bearer)
#   SIM_API_TIMEOUT  per-request timeout seconds (default 10)
#
# AWS S3 auth comes from the Lambda execution role; no keys are baked in. The
# DB is reached via the API server (not a direct RDS connection), so no DB_*
# vars are needed anymore.

FROM public.ecr.aws/lambda/python:3.12

# opencv-python-headless still needs a couple of shared libs at runtime even
# though it has no GUI; install them up front. (dnf is the package manager on
# the AL2023-based Lambda base image.)
RUN dnf install -y mesa-libGL glib2 && dnf clean all

# Install Python dependencies into the Lambda task root.
COPY docker-image/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Copy the application code (handler + production/test clients).
COPY docker-image/handler.py ${LAMBDA_TASK_ROOT}/handler.py
COPY docker-image/clients/ ${LAMBDA_TASK_ROOT}/clients/
COPY docker-image/testClients/ ${LAMBDA_TASK_ROOT}/testClients/

# Lambda writes only to /tmp; the handler anchors its working tree there.
CMD ["handler.lambda_handler"]
