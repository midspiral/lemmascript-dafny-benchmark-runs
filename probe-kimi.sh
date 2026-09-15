#!/bin/sh
set -eu

: "${SYNTHETIC_API_KEY:?Set SYNTHETIC_API_KEY first}"

# Send the credential on stdin so it does not appear in curl's process arguments.
exec curl --disable --silent --show-error --fail-with-body \
  --max-time 30 --retry 0 \
  --write-out '\nHTTP %{http_code}\n' \
  https://api.synthetic.new/anthropic/v1/messages \
  --header @- \
  --header 'anthropic-version: 2023-06-01' \
  --header 'content-type: application/json' \
  --data '{"model":"syn:large:vision","max_tokens":32,"messages":[{"role":"user","content":"Reply only OK."}]}' <<EOF
Authorization: Bearer $SYNTHETIC_API_KEY
EOF
