#!/usr/bin/env bash
# 只检查实际提供的证书和健康状态；仅在显式配置 Webhook 时发送告警。
set -euo pipefail
CERT_HOST="${CERT_HOST:-}"
CERT_PORT="${CERT_PORT:-443}"
CERT_MIN_DAYS="${CERT_MIN_DAYS:-3}"
if ! python3 -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1]); assert 1 <= int(sys.argv[2]) <= 65535; assert 0 <= int(sys.argv[3]) <= 365' "$CERT_HOST" "$CERT_PORT" "$CERT_MIN_DAYS" 2>/dev/null; then
  echo '证书检查配置无效，请设置 IPv4 地址、端口及告警天数' >&2
  exit 1
fi
alert() {
  local message="$1" payload response
  logger -t mmw-cert-check -p daemon.err "$message" || true
  printf '%s\n' "$message" >&2
  if [[ -n "${FEISHU_ALERT_WEBHOOK:-}" ]]; then
    if [[ ! "$FEISHU_ALERT_WEBHOOK" =~ ^https://open\.feishu\.cn/open-apis/bot/v2/hook/[a-zA-Z0-9-]+$ ]]; then
      echo '告警地址无效，未发送消息' >&2
      exit 1
    fi
    payload="$(python3 -c 'import json,sys; print(json.dumps({"msg_type":"text","content":{"text":sys.argv[1]}}))' "$message")"
    if ! response="$(curl -fsS --max-time 10 -X POST "$FEISHU_ALERT_WEBHOOK" -H 'Content-Type: application/json' --data "$payload" 2>/dev/null)" \
      || ! printf '%s' "$response" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(d.get("code",d.get("StatusCode")) != 0)' 2>/dev/null; then
      logger -t mmw-cert-check -p daemon.err '飞书告警发送失败' || true
    fi
  fi
  exit 1
}
certificate="$(timeout 10 openssl s_client -connect "${CERT_HOST}:${CERT_PORT}" </dev/null 2>/dev/null)" \
  || alert 'MMW 审核系统无法读取对外证书'
if ! printf '%s' "$certificate" | openssl x509 -noout -checkend "$((10#$CERT_MIN_DAYS * 86400))" >/dev/null 2>&1; then
  alert 'MMW 审核系统证书即将到期或格式无效，请检查续期任务'
fi
if ! printf '%s' "$certificate" | openssl x509 -noout -checkip "$CERT_HOST" 2>/dev/null | grep -q 'does match certificate'; then
  alert 'MMW 审核系统证书与配置的地址不匹配'
fi
if ! curl -fsS --max-time 10 "https://${CERT_HOST}:${CERT_PORT}/health" 2>/dev/null \
  | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("status") != "ok")' 2>/dev/null; then
  alert 'MMW 审核系统 HTTPS 健康检查失败'
fi
logger -t mmw-cert-check -p daemon.info '证书与健康状态检查通过'
