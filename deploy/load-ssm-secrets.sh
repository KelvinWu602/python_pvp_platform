#!/bin/bash
# load-ssm-secrets.sh
#
# Fetches API server secrets from AWS Systems Manager Parameter Store and
# writes them to /etc/python_pvp/api.env for consumption by systemd's
# EnvironmentFile= directive.
#
# Usage:   sudo bash load-ssm-secrets.sh
# Called automatically by the python-pvp-api systemd unit as ExecStartPre,
# so it runs before the Node.js process starts.
#
# Why this approach?
#   - Secrets never live in git, on disk in the app directory, or in environment
#     variables baked into the AMI / launch template.
#   - The EC2 fetches them at boot (or at each start) via its IAM instance role.
#   - The file is root-readable only (chmod 600), consumed by systemd before the
#     unprivileged appuser process sees it.
#
# SSM Parameter Store path convention (matches api-server-policy.json):
#   /python_pvp/api/DB_USER          - String
#   /python_pvp/api/DB_PASSWORD      - SecureString
#   /python_pvp/api/DB_HOST          - String
#   /python_pvp/api/DB_PORT          - String
#   /python_pvp/api/DB_NAME          - String
#   /python_pvp/api/MASTER_KEY       - SecureString
#   /python_pvp/api/BATTLE_QUEUE_URL - String
#   /python_pvp/api/AWS_REGION       - String
#   /python_pvp/api/SIM_API_TOKEN    - SecureString
#
# Required IAM permissions: see deploy/api-server-policy.json (attach to the
# EC2 instance role).  The instance role must allow ssm:GetParameter and
# ssm:GetParameters on the above paths.

set -euo pipefail

SECRET_DIR="/etc/python_pvp"
SECRET_FILE="${SECRET_DIR}/api.env"
REGION=$(curl -s http://169.254.169.254/latest/dynamic/instance-identity/document | python3 -c "import sys,json; print(json.load(sys.stdin)['region'])")

# Resolve AWS account ID from instance identity doc (avoids hardcoding it).
AWS_ACCOUNT_ID=$(curl -s http://169.254.169.254/latest/dynamic/instance-identity/document | python3 -c "import sys,json; print(json.load(sys.stdin)['accountId'])")

echo "[load-ssm-secrets] Fetching secrets from SSM (region: ${REGION})..."

mkdir -p "${SECRET_DIR}"
chmod 700 "${SECRET_DIR}"

# Fetch all non-SecureString params in one call (cheaper and atomic).
# SecureString params (password, token) must be fetched individually so the
# decrypted value is not mixed into the same output as the others.
aws ssm get-parameters \
    --names \
        "/python_pvp/api/DB_USER" \
        "/python_pvp/api/DB_HOST" \
        "/python_pvp/api/DB_PORT" \
        "/python_pvp/api/DB_NAME" \
        "/python_pvp/api/BATTLE_QUEUE_URL" \
        "/python_pvp/api/AWS_REGION" \
    --with-decrypt false \
    --region "${REGION}" \
    --output text \
    --query 'join(`\n`, sort_by(Parameters, &Name))' \
    | awk '{ print $1 "=" $4 }' \
    > "${SECRET_FILE}"

# Append SecureString params individually.
for param in "/python_pvp/api/DB_PASSWORD" "/python_pvp/api/MASTER_KEY" "/python_pvp/api/SIM_API_TOKEN"; do
    value=$(aws ssm get-parameter \
        --name "${param}" \
        --with-decrypt \
        --region "${REGION}" \
        --output text \
        --query 'Parameter.Value' \
        2>/dev/null)
    echo "${param#/python_pvp/api/}=${value}" >> "${SECRET_FILE}"
done

chmod 600 "${SECRET_FILE}"
echo "[load-ssm-secrets] Secrets written to ${SECRET_FILE} ($(wc -l < "${SECRET_FILE}") entries)"