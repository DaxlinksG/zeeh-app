#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Zeeh Africa — AWS Production Deployment
#  Sets up: ECR → ECS Fargate → ALB → ACM (SSL) → Route 53
#  Domain: api.zeehfi.ca
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="zeeh-payments"
DOMAIN="zeehfi.ca"
API_DOMAIN="api.${DOMAIN}"
REGION="ca-central-1"          # Canada — closest to your users
PORT=3000
CPU=512                         # 0.5 vCPU  (scales up later)
MEMORY=1024                     # 1 GB RAM
DESIRED_COUNT=2                 # 2 containers for HA (high availability)

# Colours
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step()  { echo -e "\n${BLUE}▶  $1${NC}"; }
ok()    { echo -e "${GREEN}✔  $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠  $1${NC}"; }
error() { echo -e "${RED}✖  $1${NC}"; exit 1; }

# ── Prereq checks ─────────────────────────────────────────────────────────────
step "Checking prerequisites"

command -v aws    &>/dev/null || error "AWS CLI not found. Run: brew install awscli"
command -v docker &>/dev/null || error "Docker not found. Install from https://docker.com"

AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || error "AWS credentials not configured. Run: aws configure"

ok "AWS account: ${AWS_ACCOUNT}"
ok "Region:      ${REGION}"

ECR_REGISTRY="${AWS_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${ECR_REGISTRY}/${APP_NAME}:latest"

# ── Prompt for secrets (skip if already in environment) ───────────────────────
step "Collecting secrets (stored in AWS Secrets Manager — never in files)"

if [[ -z "${GTP_API_KEY:-}" ]]; then
  read -rsp "Enter your GTP_API_KEY: " GTP_API_KEY; echo
fi
if [[ -z "${SERVICE_API_KEY:-}" ]]; then
  read -rsp "Enter your SERVICE_API_KEY (key your clients will use): " SERVICE_API_KEY; echo
fi
[[ -z "$GTP_API_KEY" ]]     && error "GTP_API_KEY cannot be empty"
[[ -z "$SERVICE_API_KEY" ]] && error "SERVICE_API_KEY cannot be empty"

# ── Store secrets in AWS Secrets Manager ─────────────────────────────────────
step "Storing secrets in AWS Secrets Manager"

SECRET_ARN=$(aws secretsmanager create-secret \
  --name "${APP_NAME}/production" \
  --region "${REGION}" \
  --secret-string "{\"GTP_API_KEY\":\"${GTP_API_KEY}\",\"SERVICE_API_KEY\":\"${SERVICE_API_KEY}\"}" \
  --query ARN --output text 2>/dev/null) || \
SECRET_ARN=$(aws secretsmanager update-secret \
  --secret-id "${APP_NAME}/production" \
  --region "${REGION}" \
  --secret-string "{\"GTP_API_KEY\":\"${GTP_API_KEY}\",\"SERVICE_API_KEY\":\"${SERVICE_API_KEY}\"}" \
  --query ARN --output text)

ok "Secrets stored: ${SECRET_ARN}"

# ── ECR: Create repo and push image ──────────────────────────────────────────
step "Creating ECR repository"

aws ecr create-repository \
  --repository-name "${APP_NAME}" \
  --region "${REGION}" \
  --image-scanning-configuration scanOnPush=true \
  --output json &>/dev/null || ok "ECR repo already exists"

step "Building Docker image"
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 -t "${APP_NAME}:latest" .
ok "Image built"

step "Pushing image to ECR"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

docker tag "${APP_NAME}:latest" "${IMAGE_URI}"
docker push "${IMAGE_URI}"
ok "Image pushed: ${IMAGE_URI}"

# ── IAM: ECS task execution role ─────────────────────────────────────────────
step "Creating ECS task execution role"

TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

EXEC_ROLE_ARN=$(aws iam create-role \
  --role-name "${APP_NAME}-task-exec-role" \
  --assume-role-policy-document "${TRUST_POLICY}" \
  --query Role.Arn --output text 2>/dev/null) || \
EXEC_ROLE_ARN=$(aws iam get-role \
  --role-name "${APP_NAME}-task-exec-role" \
  --query Role.Arn --output text)

aws iam attach-role-policy \
  --role-name "${APP_NAME}-task-exec-role" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
  &>/dev/null || true

# Allow reading from Secrets Manager
aws iam attach-role-policy \
  --role-name "${APP_NAME}-task-exec-role" \
  --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite \
  &>/dev/null || true

ok "Execution role: ${EXEC_ROLE_ARN}"

# ── VPC: Use default VPC ──────────────────────────────────────────────────────
step "Getting VPC and subnets"

VPC_ID=$(aws ec2 describe-vpcs \
  --region "${REGION}" \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

SUBNET_IDS=$(aws ec2 describe-subnets \
  --region "${REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

ok "VPC: ${VPC_ID}"
ok "Subnets: ${SUBNET_IDS}"

# ── Security Groups ───────────────────────────────────────────────────────────
step "Creating security groups"

ALB_SG_ID=$(aws ec2 create-security-group \
  --group-name "${APP_NAME}-alb-sg" \
  --description "ALB security group for ${APP_NAME}" \
  --vpc-id "${VPC_ID}" \
  --region "${REGION}" \
  --query GroupId --output text 2>/dev/null) || \
ALB_SG_ID=$(aws ec2 describe-security-groups \
  --region "${REGION}" \
  --filters "Name=group-name,Values=${APP_NAME}-alb-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "${ALB_SG_ID}" --region "${REGION}" \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 &>/dev/null || true
aws ec2 authorize-security-group-ingress --group-id "${ALB_SG_ID}" --region "${REGION}" \
  --protocol tcp --port 443 --cidr 0.0.0.0/0 &>/dev/null || true

APP_SG_ID=$(aws ec2 create-security-group \
  --group-name "${APP_NAME}-app-sg" \
  --description "App security group for ${APP_NAME}" \
  --vpc-id "${VPC_ID}" \
  --region "${REGION}" \
  --query GroupId --output text 2>/dev/null) || \
APP_SG_ID=$(aws ec2 describe-security-groups \
  --region "${REGION}" \
  --filters "Name=group-name,Values=${APP_NAME}-app-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "${APP_SG_ID}" --region "${REGION}" \
  --protocol tcp --port "${PORT}" --source-group "${ALB_SG_ID}" &>/dev/null || true

ok "ALB SG: ${ALB_SG_ID} | App SG: ${APP_SG_ID}"

# ── ALB: Load Balancer ────────────────────────────────────────────────────────
step "Creating Application Load Balancer"

SUBNET_LIST=$(echo "${SUBNET_IDS}" | tr ',' ' ')

ALB_ARN=$(aws elbv2 create-load-balancer \
  --name "${APP_NAME}-alb" \
  --subnets ${SUBNET_LIST} \
  --security-groups "${ALB_SG_ID}" \
  --region "${REGION}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null) || \
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names "${APP_NAME}-alb" \
  --region "${REGION}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "${ALB_ARN}" \
  --region "${REGION}" \
  --query 'LoadBalancers[0].DNSName' --output text)

ALB_ZONE_ID=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "${ALB_ARN}" \
  --region "${REGION}" \
  --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)

ok "ALB DNS: ${ALB_DNS}"

# Target group
TG_ARN=$(aws elbv2 create-target-group \
  --name "${APP_NAME}-tg" \
  --protocol HTTP \
  --port "${PORT}" \
  --vpc-id "${VPC_ID}" \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null) || \
TG_ARN=$(aws elbv2 describe-target-groups \
  --names "${APP_NAME}-tg" \
  --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# HTTP listener (redirects to HTTPS)
aws elbv2 create-listener \
  --load-balancer-arn "${ALB_ARN}" \
  --protocol HTTP --port 80 \
  --region "${REGION}" \
  --default-actions "Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}" \
  --output json &>/dev/null || true

ok "Target group: ${TG_ARN}"

# ── ACM: SSL Certificate ──────────────────────────────────────────────────────
step "Requesting SSL certificate for ${API_DOMAIN}"

CERT_ARN=$(aws acm request-certificate \
  --domain-name "${API_DOMAIN}" \
  --subject-alternative-names "${DOMAIN}" \
  --validation-method DNS \
  --region "${REGION}" \
  --query CertificateArn --output text 2>/dev/null) || \
CERT_ARN=$(aws acm list-certificates \
  --region "${REGION}" \
  --query "CertificateSummaryList[?DomainName=='${API_DOMAIN}'].CertificateArn | [0]" \
  --output text)

ok "Certificate ARN: ${CERT_ARN}"

# HTTPS listener
aws elbv2 create-listener \
  --load-balancer-arn "${ALB_ARN}" \
  --protocol HTTPS --port 443 \
  --certificates "CertificateArn=${CERT_ARN}" \
  --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" \
  --region "${REGION}" \
  --output json &>/dev/null || true

# ── CloudWatch Logs ───────────────────────────────────────────────────────────
step "Creating CloudWatch log group"

aws logs create-log-group \
  --log-group-name "/ecs/${APP_NAME}" \
  --region "${REGION}" &>/dev/null || true

ok "Log group: /ecs/${APP_NAME}"

# ── ECS Cluster ───────────────────────────────────────────────────────────────
step "Creating ECS cluster"

aws ecs create-cluster \
  --cluster-name "${APP_NAME}" \
  --capacity-providers FARGATE \
  --region "${REGION}" \
  --output json &>/dev/null || true

ok "Cluster: ${APP_NAME}"

# ── ECS Task Definition ───────────────────────────────────────────────────────
step "Registering ECS task definition"

TASK_DEF=$(cat <<EOF
{
  "family": "${APP_NAME}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${CPU}",
  "memory": "${MEMORY}",
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${EXEC_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "${APP_NAME}",
      "image": "${IMAGE_URI}",
      "portMappings": [{"containerPort": ${PORT}, "protocol": "tcp"}],
      "essential": true,
      "environment": [
        {"name": "NODE_ENV",        "value": "production"},
        {"name": "PORT",            "value": "${PORT}"},
        {"name": "GTP_BASE_URL",    "value": "https://gtp-service-sandbox-1022294938286.northamerica-northeast1.run.app/gtp/v1"},
        {"name": "DEFAULT_SPREAD_PCT", "value": "2.0"}
      ],
      "secrets": [
        {"name": "GTP_API_KEY",     "valueFrom": "${SECRET_ARN}:GTP_API_KEY::"},
        {"name": "SERVICE_API_KEY", "valueFrom": "${SECRET_ARN}:SERVICE_API_KEY::"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":  "/ecs/${APP_NAME}",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://localhost:${PORT}/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 10
      }
    }
  ]
}
EOF
)

TASK_DEF_ARN=$(aws ecs register-task-definition \
  --region "${REGION}" \
  --cli-input-json "${TASK_DEF}" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

ok "Task definition: ${TASK_DEF_ARN}"

# ── ECS Service ───────────────────────────────────────────────────────────────
step "Creating ECS service (${DESIRED_COUNT} containers)"

NETWORK_CONFIG="awsvpcConfiguration={subnets=[$(echo $SUBNET_IDS | tr ',' ',')],securityGroups=[${APP_SG_ID}],assignPublicIp=ENABLED}"

aws ecs create-service \
  --cluster "${APP_NAME}" \
  --service-name "${APP_NAME}-service" \
  --task-definition "${APP_NAME}" \
  --desired-count "${DESIRED_COUNT}" \
  --launch-type FARGATE \
  --network-configuration "${NETWORK_CONFIG}" \
  --load-balancers "targetGroupArn=${TG_ARN},containerName=${APP_NAME},containerPort=${PORT}" \
  --health-check-grace-period-seconds 60 \
  --region "${REGION}" \
  --output json &>/dev/null || \
aws ecs update-service \
  --cluster "${APP_NAME}" \
  --service "${APP_NAME}-service" \
  --task-definition "${APP_NAME}" \
  --desired-count "${DESIRED_COUNT}" \
  --region "${REGION}" \
  --output json &>/dev/null

ok "ECS service created with ${DESIRED_COUNT} containers"

# ── Route 53 ──────────────────────────────────────────────────────────────────
step "Creating Route 53 hosted zone for ${DOMAIN}"

HOSTED_ZONE_ID=$(aws route53 create-hosted-zone \
  --name "${DOMAIN}" \
  --caller-reference "$(date +%s)" \
  --query 'HostedZone.Id' --output text 2>/dev/null | cut -d'/' -f3) || \
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name "${DOMAIN}" \
  --query 'HostedZones[0].Id' --output text | cut -d'/' -f3)

# A record: api.zeehfi.ca → ALB
CHANGE_BATCH=$(cat <<EOF
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${API_DOMAIN}",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "${ALB_ZONE_ID}",
        "DNSName": "dualstack.${ALB_DNS}",
        "EvaluateTargetHealth": true
      }
    }
  }]
}
EOF
)

aws route53 change-resource-record-sets \
  --hosted-zone-id "${HOSTED_ZONE_ID}" \
  --change-batch "${CHANGE_BATCH}" \
  --output json &>/dev/null

ok "Route 53 hosted zone: ${HOSTED_ZONE_ID}"

# Get the NS records for Namecheap
NS_RECORDS=$(aws route53 get-hosted-zone \
  --id "${HOSTED_ZONE_ID}" \
  --query 'DelegationSet.NameServers' --output text | tr '\t' '\n')

# ── Auto Scaling ──────────────────────────────────────────────────────────────
step "Configuring auto-scaling (2–10 containers)"

SERVICE_RESOURCE="service/${APP_NAME}/${APP_NAME}-service"

aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id "${SERVICE_RESOURCE}" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 10 \
  --region "${REGION}" &>/dev/null || true

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "${SERVICE_RESOURCE}" \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name "${APP_NAME}-cpu-scaling" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration \
    '{"TargetValue":70.0,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"},"ScaleInCooldown":300,"ScaleOutCooldown":60}' \
  --region "${REGION}" &>/dev/null || true

ok "Auto-scaling: 2–10 containers, triggers at 70% CPU"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  🚀  Zeeh Africa deployed to AWS!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  API (once DNS propagates):  ${BLUE}https://api.zeehfi.ca${NC}"
echo -e "  Docs:                       ${BLUE}https://api.zeehfi.ca/docs${NC}"
echo -e "  ALB (available now):        ${BLUE}http://${ALB_DNS}${NC}"
echo ""
echo -e "${YELLOW}━━━━  ACTION REQUIRED: Update Namecheap DNS  ━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  1. Log in to Namecheap → zeehfi.ca → Manage"
echo "  2. Change Nameservers to: Custom DNS"
echo "  3. Add these 4 nameservers (from Route 53):"
echo ""
echo "${NS_RECORDS}" | while read -r ns; do
  echo -e "     ${BLUE}${ns}${NC}"
done
echo ""
echo -e "${YELLOW}━━━━  ACTION REQUIRED: Validate SSL Certificate  ━━━━━━━━━━━━${NC}"
echo ""
echo "  1. Go to AWS Console → Certificate Manager → ${CERT_ARN}"
echo "  2. Click 'Create records in Route 53' (one click)"
echo "  3. Certificate validates in ~5 minutes"
echo ""
echo -e "${YELLOW}  DNS propagation takes 5–30 minutes after Namecheap update.${NC}"
echo ""
echo -e "  Monitor deployment:"
echo -e "  ${BLUE}aws ecs describe-services --cluster ${APP_NAME} --services ${APP_NAME}-service --region ${REGION}${NC}"
echo ""
echo -e "  View live logs:"
echo -e "  ${BLUE}aws logs tail /ecs/${APP_NAME} --follow --region ${REGION}${NC}"
echo ""
