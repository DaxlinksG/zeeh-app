#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Zeeh Africa — Redeploy (code change only, no infra changes)
#  Run this every time you push new code to production.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_NAME="zeeh-payments"
REGION="ca-central-1"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
ok() { echo -e "${GREEN}✔  $1${NC}"; }
step() { echo -e "\n${BLUE}▶  $1${NC}"; }

AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${AWS_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${ECR_REGISTRY}/${APP_NAME}:latest"

step "Building new Docker image"
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 -t "${APP_NAME}:latest" .
ok "Image built"

step "Pushing to ECR"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
docker tag "${APP_NAME}:latest" "${IMAGE_URI}"
docker push "${IMAGE_URI}"
ok "Image pushed"

step "Forcing new ECS deployment"
aws ecs update-service \
  --cluster "${APP_NAME}" \
  --service "${APP_NAME}-service" \
  --force-new-deployment \
  --region "${REGION}" \
  --output json &>/dev/null
ok "Deployment triggered — rolling update in progress (zero downtime)"

echo ""
echo "Monitor: aws ecs describe-services --cluster ${APP_NAME} --services ${APP_NAME}-service --region ${REGION} --query 'services[0].deployments'"
echo "Logs:    aws logs tail /ecs/${APP_NAME} --follow --region ${REGION}"
