#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Zeeh Africa — CloudWatch Alarms + SNS Alerts
#  Monitors: container health, error rate, CPU, memory
#  Alerts go to: zeehafricah@gmail.com
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="ca-central-1"
APP_NAME="zeeh-payments"
ALERT_EMAIL="zeehafricah@gmail.com"
ALB_NAME="zeeh-payments-alb"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
step() { echo -e "\n${BLUE}▶  $1${NC}"; }
ok()   { echo -e "${GREEN}✔  $1${NC}"; }

# ── SNS Topic (email alerts) ──────────────────────────────────────────────────
step "Creating SNS alert topic"

TOPIC_ARN=$(aws sns create-topic \
  --name "${APP_NAME}-alerts" \
  --region "${REGION}" \
  --query TopicArn --output text)

# Subscribe email (user gets a confirmation email — must click it)
aws sns subscribe \
  --topic-arn "${TOPIC_ARN}" \
  --protocol email \
  --notification-endpoint "${ALERT_EMAIL}" \
  --region "${REGION}" --output json &>/dev/null || true

ok "SNS topic: ${TOPIC_ARN}"
echo "   📧 Confirmation email sent to ${ALERT_EMAIL} — click the link to activate alerts"

# ── Get ALB dimensions ────────────────────────────────────────────────────────
ALB_SUFFIX=$(aws elbv2 describe-load-balancers \
  --names "${ALB_NAME}" --region "${REGION}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text \
  | sed 's|.*loadbalancer/||')

TG_SUFFIX=$(aws elbv2 describe-target-groups \
  --names "${APP_NAME}-tg" --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text \
  | sed 's|.*targetgroup/|targetgroup/|')

# ── Alarm 1: Containers below desired count ───────────────────────────────────
step "Alarm: Container count drops below 2"

aws cloudwatch put-metric-alarm \
  --alarm-name "${APP_NAME}-containers-unhealthy" \
  --alarm-description "ECS running count dropped below desired — containers may be crashing" \
  --metric-name RunningTaskCount \
  --namespace AWS/ECS \
  --dimensions Name=ClusterName,Value=${APP_NAME} Name=ServiceName,Value=${APP_NAME}-service \
  --statistic Average \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 2 \
  --comparison-operator LessThanThreshold \
  --alarm-actions "${TOPIC_ARN}" \
  --ok-actions "${TOPIC_ARN}" \
  --treat-missing-data breaching \
  --region "${REGION}"
ok "Alarm set — triggers if running containers < 2"

# ── Alarm 2: High 5xx error rate ──────────────────────────────────────────────
step "Alarm: High HTTP 5xx error rate (> 10 per minute)"

aws cloudwatch put-metric-alarm \
  --alarm-name "${APP_NAME}-high-errors" \
  --alarm-description "More than 10 server errors per minute — investigate immediately" \
  --metric-name HTTPCode_Target_5XX_Count \
  --namespace AWS/ApplicationELB \
  --dimensions Name=LoadBalancer,Value=${ALB_SUFFIX} \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "${TOPIC_ARN}" \
  --treat-missing-data notBreaching \
  --region "${REGION}"
ok "Alarm set — triggers if 5xx errors > 10/min for 2 minutes"

# ── Alarm 3: High CPU ─────────────────────────────────────────────────────────
step "Alarm: CPU above 80% (auto-scaling kicks in at 70%)"

aws cloudwatch put-metric-alarm \
  --alarm-name "${APP_NAME}-high-cpu" \
  --alarm-description "CPU above 80% — auto-scaling should be adding containers" \
  --metric-name CPUUtilization \
  --namespace AWS/ECS \
  --dimensions Name=ClusterName,Value=${APP_NAME} Name=ServiceName,Value=${APP_NAME}-service \
  --statistic Average \
  --period 60 \
  --evaluation-periods 3 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "${TOPIC_ARN}" \
  --ok-actions "${TOPIC_ARN}" \
  --treat-missing-data notBreaching \
  --region "${REGION}"
ok "Alarm set — triggers if avg CPU > 80% for 3 minutes"

# ── Alarm 4: High memory ──────────────────────────────────────────────────────
step "Alarm: Memory above 80%"

aws cloudwatch put-metric-alarm \
  --alarm-name "${APP_NAME}-high-memory" \
  --alarm-description "Memory above 80% — consider increasing task memory" \
  --metric-name MemoryUtilization \
  --namespace AWS/ECS \
  --dimensions Name=ClusterName,Value=${APP_NAME} Name=ServiceName,Value=${APP_NAME}-service \
  --statistic Average \
  --period 60 \
  --evaluation-periods 3 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "${TOPIC_ARN}" \
  --ok-actions "${TOPIC_ARN}" \
  --treat-missing-data notBreaching \
  --region "${REGION}"
ok "Alarm set — triggers if avg memory > 80% for 3 minutes"

# ── Alarm 5: Unhealthy targets ────────────────────────────────────────────────
step "Alarm: Unhealthy targets in load balancer"

aws cloudwatch put-metric-alarm \
  --alarm-name "${APP_NAME}-unhealthy-targets" \
  --alarm-description "ALB health checks failing — containers not responding" \
  --metric-name UnHealthyHostCount \
  --namespace AWS/ApplicationELB \
  --dimensions Name=LoadBalancer,Value=${ALB_SUFFIX} Name=TargetGroup,Value=${TG_SUFFIX} \
  --statistic Average \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "${TOPIC_ARN}" \
  --ok-actions "${TOPIC_ARN}" \
  --treat-missing-data notBreaching \
  --region "${REGION}"
ok "Alarm set — triggers if any containers fail health checks"

# ── Dashboard ─────────────────────────────────────────────────────────────────
step "Creating CloudWatch dashboard"

DASHBOARD=$(cat <<EOF
{
  "widgets": [
    {"type":"metric","x":0,"y":0,"width":12,"height":6,
     "properties":{"title":"Running Containers","metrics":[["AWS/ECS","RunningTaskCount","ClusterName","${APP_NAME}","ServiceName","${APP_NAME}-service"]],"period":60,"stat":"Average","view":"timeSeries"}},
    {"type":"metric","x":12,"y":0,"width":12,"height":6,
     "properties":{"title":"CPU Utilization %","metrics":[["AWS/ECS","CPUUtilization","ClusterName","${APP_NAME}","ServiceName","${APP_NAME}-service"]],"period":60,"stat":"Average","view":"timeSeries"}},
    {"type":"metric","x":0,"y":6,"width":12,"height":6,
     "properties":{"title":"5xx Errors / min","metrics":[["AWS/ApplicationELB","HTTPCode_Target_5XX_Count","LoadBalancer","${ALB_SUFFIX}"]],"period":60,"stat":"Sum","view":"timeSeries"}},
    {"type":"metric","x":12,"y":6,"width":12,"height":6,
     "properties":{"title":"Request Count / min","metrics":[["AWS/ApplicationELB","RequestCount","LoadBalancer","${ALB_SUFFIX}"]],"period":60,"stat":"Sum","view":"timeSeries"}}
  ]
}
EOF
)

aws cloudwatch put-dashboard \
  --dashboard-name "${APP_NAME}" \
  --dashboard-body "${DASHBOARD}" \
  --region "${REGION}" --output json &>/dev/null

DASH_URL="https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=${APP_NAME}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  📊  CloudWatch monitoring is live!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Alarms set (5 total):"
echo "   🔴 Container count < 2"
echo "   🔴 5xx error rate > 10/min"
echo "   🟡 CPU > 80%"
echo "   🟡 Memory > 80%"
echo "   🔴 Unhealthy ALB targets"
echo ""
echo "  📧 Alerts → ${ALERT_EMAIL}"
echo "     (check inbox — click the confirmation link from AWS)"
echo ""
echo "  Dashboard: ${DASH_URL}"
echo ""
