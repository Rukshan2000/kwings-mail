#!/usr/bin/env bash
# Runs on the VPS from /opt/kwings-mail as the forced command of the CI deploy key.
#   CI:     echo "$GHCR_TOKEN" | ssh gh-runner@host <commit-sha>
#   Manual: ./deploy.sh <commit-sha>   (uses the existing ghcr.io login)
# Never removes volumes: all mail lives in the "kwings-mail_data" volume.
set -euo pipefail
cd "$(dirname "$0")"

tag="${SSH_ORIGINAL_COMMAND:-${1:-}}"
[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: deploy.sh <commit-sha>" >&2; exit 2; }

if [[ ! -t 0 ]]; then
  token="$(cat)"
  [[ -z "$token" ]] || docker login ghcr.io -u rukshan2000 --password-stdin <<<"$token" >/dev/null
fi

export IMAGE_TAG="$tag"
# ponytail: no automatic rollback; run ./deploy.sh <previous-sha> from .deploy-history if a release is bad.
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans --wait --wait-timeout 120
echo "$tag" >>.deploy-history
docker image prune -f >/dev/null
echo "Deployed $tag"
