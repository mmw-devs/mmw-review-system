"""离线验证证书检查失败路径；所有网络与日志命令均替换为本地桩。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
STUB = '''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
mode = os.environ.get('TEST_MODE', 'ok')
args = sys.argv[1:]
if name == 'timeout':
    os.execvp(args[1], args[1:])
elif name == 'openssl':
    if 's_client' in args:
        if mode == 'connection': sys.exit(1)
        print('mock certificate')
    elif '-checkend' in args:
        sys.exit(1 if mode == 'expired' else 0)
    else:
        print('IP does not match certificate' if mode == 'san' else 'IP does match certificate')
elif name == 'curl':
    if '-X' in args:
        payload = json.loads(args[args.index('--data') + 1])
        pathlib.Path(os.environ['TEST_PAYLOAD']).write_text(json.dumps(payload))
        print(json.dumps({'code': 1 if mode == 'webhook' else 0}))
    else:
        print(json.dumps({'status': 'failed' if mode in ('health', 'webhook') else 'ok'}))
elif name == 'logger':
    with open(os.environ['TEST_LOG'], 'a') as log: log.write(' '.join(args) + '\\n')
'''

class CertificateChecks(unittest.TestCase):
    def run_check(self, mode='ok', webhook=False, host='192.0.2.1'):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            for name in ('timeout', 'openssl', 'curl', 'logger'):
                target = folder / name
                target.write_text(STUB)
                target.chmod(0o700)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                   'CERT_HOST': host, 'CERT_PORT': '443', 'CERT_MIN_DAYS': '3',
                   'TEST_MODE': mode, 'TEST_PAYLOAD': str(folder / 'payload'),
                   'TEST_LOG': str(folder / 'log'),
                   'FEISHU_ALERT_WEBHOOK': 'https://open.feishu.cn/open-apis/bot/v2/hook/mock' if webhook else ''}
            result = subprocess.run(['bash', str(ROOT / 'deploy/cert-check.sh')], env=env,
                                    capture_output=True, text=True, timeout=5)
            payload = json.loads((folder / 'payload').read_text()) if (folder / 'payload').exists() else None
            log = (folder / 'log').read_text() if (folder / 'log').exists() else ''
            self.assertNotIn(host, result.stdout + result.stderr + log)
            return result, payload, log

    def test_healthy_without_notification(self):
        result, payload, _ = self.run_check()
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(payload)

    def test_each_failure_without_webhook(self):
        for mode in ('connection', 'expired', 'san', 'health'):
            with self.subTest(mode=mode):
                result, payload, _ = self.run_check(mode)
                self.assertEqual(result.returncode, 1)
                self.assertIsNone(payload)

    def test_notification_is_valid_json_and_failure_stays_failed(self):
        result, payload, _ = self.run_check('expired', True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload['msg_type'], 'text')
        self.assertIn('即将到期', payload['content']['text'])

    def test_notification_api_error_is_recorded(self):
        result, _, log = self.run_check('webhook', True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('飞书告警发送失败', log)

    def test_invalid_config_stops_before_network(self):
        result, payload, log = self.run_check(host='invalid')
        self.assertEqual(result.returncode, 1)
        self.assertIsNone(payload)
        self.assertEqual(log, '')

if __name__ == '__main__':
    unittest.main()
