#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Zeeh Africa — Enable HTTPS
#  Run this once after DNS propagates and SSL cert is validated.
#  Adds HTTPS listener and redirects HTTP → HTTPS.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="ca-central-1"
APP_NAME="zeeh-payments"
CERT_ARN="arn:aws:acm:ca-central-1:973920270561:certificate/7754b1db-3741-407a-a16a-d903443b4697"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
step() { echo -e "\n${BLUE}▶  $1${NC}"; }
ok()   { echo -e "${GREEN}✔  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }

# ── Check cert status ─────────────────────────────────────────────────────────
step "Checking SSL certificate status"

CERT_STATUS=$(aws acm describe-certificate \
  --certificate-arn "${CERT_ARN}" \
  --region "${REGION}" \
  --query 'Certificate.Status' --output text)

if [[ "${CERT_STATUS}" != "ISSUED" ]]; then
  warn "Certificate is still '${CERT_STATUS}' — not ready yet."
  warn "DNS usually propagates in 5–30 minutes after Namecheap update."
  warn "Try again in a few minutes: bash infra/enable-https.sh"
  exit 1
fi

ok "Certificate is ISSUED ✅"

# ── Get resources ─────────────────────────────────────────────────────────────
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names "${APP_NAME}-alb" --region "${REGION}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

TG_ARN=$(aws elbv2 describe-target-groups \
  --names "${APP_NAME}-tg" --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

HTTP_LISTENER=$(aws elbv2 describe-listeners \
  --load-balancer-arn "${ALB_ARN}" --region "${REGION}" \
  --query 'Listeners[?Port==`80`].ListenerArn' --output text)

# ── Add HTTPS listener ────────────────────────────────────────────────────────
step "Adding HTTPS listener (port 443)"

aws elbv2 create-listener \
  --load-balancer-arn "${ALB_ARN}" \
  --protocol HTTPS --port 443 \
  --certificates "CertificateArn=${CERT_ARN}" \
  --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" \
  --region "${REGION}" \
  --output text --query 'Listeners[0].ListenerArn' &>/dev/null || ok "HTTPS listener already exists"

ok "HTTPS live on port 443"

# ── Update HTTP to redirect HTTPS ─────────────────────────────────────────────
step "Redirecting HTTP → HTTPS (port 80)"

aws elbv2 modify-listener \
  --listener-arn "${HTTP_LISTENER}" \
  --default-actions "Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}" \
  --region "${REGION}" --output json &>/dev/null

ok "HTTP now redirects to HTTPS"

# ── Final test ────────────────────────────────────────────────────────────────
step "Testing endpoints"

sleep 3
HEALTH=$(curl -s --max-time 8 "https://api.zeehfi.ca/health" 2>/dev/null || echo "DNS still propagating")
echo "  https://api.zeehfi.ca/health  →  ${HEALTH}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  🔒  HTTPS enabled!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  API :  ${BLUE}https://api.zeehfi.ca${NC}"
echo -e "  Docs:  ${BLUE}https://api.zeehfi.ca/docs${NC}"
echo ""
