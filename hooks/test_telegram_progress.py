"""Offline tests for telegram-progress.py: fake transcripts, a mock Bot API on
localhost, a fake token in a temp state dir. No network, no real bot.

    python3 -m unittest hooks/test_telegram_progress.py -v
"""
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'telegram-progress.py')
FAKE_TOKEN = '123456:FAKE-offline-test-token'
DM, STRANGER, GROUP = '111', '222', '-1001'


class Mock(http.server.BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])) or b'{}')
        Mock.calls.append((self.path, body))
        out = json.dumps({'ok': True, 'result': True}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def channel_turn(chat_id, message_id, text='làm việc X'):
    return {
        'type': 'user', 'isMeta': True, 'isSidechain': False,
        'origin': {'kind': 'channel', 'server': 'plugin:telegram:telegram'},
        'message': {'role': 'user', 'content':
                    f'<channel source="plugin:telegram:telegram" chat_id="{chat_id}" message_id="{message_id}" '
                    f'user="alice" user_id="{chat_id}" ts="2026-10-17T00:00:00.000Z">\n{text}\n</channel>'},
    }


def human_turn(text='gõ trong terminal'):
    return {'type': 'user', 'isSidechain': False, 'origin': {'kind': 'human'},
            'message': {'role': 'user', 'content': text}}


def tool_result(size=100):
    return {'type': 'user', 'isSidechain': False,
            'message': {'role': 'user', 'content': [
                {'tool_use_id': 'toolu_1', 'type': 'tool_result', 'content': 'x' * size}]}}


def assistant():
    return {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]}}


class HookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Mock.calls.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.dir.name, 'state')
        os.makedirs(self.state)
        with open(os.path.join(self.state, '.env'), 'w') as f:
            f.write(f'TELEGRAM_BOT_TOKEN={FAKE_TOKEN}\n')
        with open(os.path.join(self.state, 'access.json'), 'w') as f:
            json.dump({'dmPolicy': 'allowlist', 'allowFrom': [DM], 'groups': {GROUP: {}}, 'pending': {}}, f)
        self.transcript = os.path.join(self.dir.name, 't.jsonl')
        self.api = f'http://127.0.0.1:{self.srv.server_address[1]}'

    def tearDown(self):
        self.dir.cleanup()

    def write(self, *entries):
        with open(self.transcript, 'w') as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False, separators=(',', ':')) + '\n')

    def run_hook(self, tool='Bash', tool_input=None, api=None, raw_stdin=None):
        payload = raw_stdin if raw_stdin is not None else json.dumps({
            'hook_event_name': 'PreToolUse', 'transcript_path': self.transcript,
            'tool_name': tool, 'tool_input': tool_input if tool_input is not None else {'command': 'ls', 'description': 'Kiểm agent rnd'},
        })
        env = {'PATH': os.environ.get('PATH', ''), 'HOME': self.dir.name,
               'TELEGRAM_STATE_DIR': self.state, 'TELEGRAM_API_ROOT': api or self.api}
        t = time.time()
        p = subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True, env=env, timeout=10)
        return p, time.time() - t

    def test_telegram_turn_sends_draft(self):
        self.write(channel_turn(DM, 8591), assistant(), tool_result())
        p, _ = self.run_hook()
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, '', ''))
        self.assertEqual(len(Mock.calls), 1)
        path, body = Mock.calls[0]
        self.assertEqual(path, f'/bot{FAKE_TOKEN}/sendMessageDraft')
        self.assertEqual(body['chat_id'], 111)
        self.assertEqual(body['draft_id'], 8591)
        self.assertIn('Bash: Kiểm agent rnd', body['text'])

    def test_terminal_turn_does_nothing(self):
        self.write(channel_turn(DM, 1), assistant(), human_turn(), assistant())
        p, _ = self.run_hook()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(Mock.calls, [])

    def test_bang_command_in_terminal_counts_as_terminal(self):
        self.write(channel_turn(DM, 1), assistant(),
                   {'type': 'user', 'message': {'role': 'user', 'content': '<bash-input>ls</bash-input>'}})
        self.run_hook()
        self.assertEqual(Mock.calls, [])

    def test_group_chat_does_nothing(self):
        self.write(channel_turn(GROUP, 50))
        self.run_hook()
        self.assertEqual(Mock.calls, [])

    def test_not_allowlisted_does_nothing(self):
        self.write(channel_turn(STRANGER, 50))
        self.run_hook()
        self.assertEqual(Mock.calls, [])

    def test_telegram_tools_are_skipped(self):
        self.write(channel_turn(DM, 9))
        self.run_hook(tool='mcp__plugin_telegram_telegram__reply', tool_input={'chat_id': DM, 'text': 'hi'})
        self.assertEqual(Mock.calls, [])

    def test_throttle_and_rolling_steps(self):
        self.write(channel_turn(DM, 10))
        self.run_hook(tool='Read', tool_input={'file_path': '/a/b/server.ts'})
        self.run_hook(tool='Edit', tool_input={'file_path': '/a/b/README.md'})   # within 1s: not sent
        self.assertEqual(len(Mock.calls), 1)
        time.sleep(1.1)
        self.run_hook(tool='Agent', tool_input={'description': 'Soát log herdr'})
        self.assertEqual(len(Mock.calls), 2)
        text = Mock.calls[1][1]['text']
        self.assertIn('Đọc file: server.ts', text)
        self.assertIn('Sửa file: README.md', text)  # throttled step still shows up later
        self.assertIn('▸ Agent: Soát log herdr', text)

    def test_new_message_resets_draft(self):
        self.write(channel_turn(DM, 20))
        self.run_hook(tool='Read', tool_input={'file_path': '/x/old.txt'})
        time.sleep(1.1)
        self.write(channel_turn(DM, 21))
        self.run_hook(tool='Read', tool_input={'file_path': '/x/new.txt'})
        self.assertEqual(Mock.calls[1][1]['draft_id'], 21)
        self.assertNotIn('old.txt', Mock.calls[1][1]['text'])

    def test_network_error_exits_zero_fast(self):
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        dead = f'http://127.0.0.1:{s.getsockname()[1]}'
        s.close()
        self.write(channel_turn(DM, 30))
        p, dt = self.run_hook(api=dead)
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, '', ''))
        self.assertLess(dt, 3)

    def test_slow_api_is_cut_at_two_seconds(self):
        lst = socket.socket()
        lst.bind(('127.0.0.1', 0))
        lst.listen(1)  # accepts the TCP connection, never answers
        self.write(channel_turn(DM, 31))
        p, dt = self.run_hook(api=f'http://127.0.0.1:{lst.getsockname()[1]}')
        lst.close()
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, '', ''))
        self.assertLess(dt, 3.5)

    def test_garbage_input_exits_zero(self):
        for raw in ['', 'not json', '{"transcript_path": "/nope"}', '[]']:
            p, _ = self.run_hook(raw_stdin=raw)
            self.assertEqual((p.returncode, p.stdout, p.stderr), (0, '', ''))
        self.assertEqual(Mock.calls, [])

    def test_missing_token_or_access_exits_zero(self):
        self.write(channel_turn(DM, 40))
        os.remove(os.path.join(self.state, '.env'))
        p, _ = self.run_hook()
        self.assertEqual(p.returncode, 0)
        os.remove(os.path.join(self.state, 'access.json'))
        p, _ = self.run_hook()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(Mock.calls, [])

    def test_secrets_are_masked_and_lines_cut(self):
        self.write(channel_turn(DM, 50))
        # Token-shaped string built at runtime so secret scanners don't flag this file.
        fake_bot_token = '123456789' + ':' + 'AAHfiqksKZ8' + 'q' * 30
        auth_header = 'Author' + 'ization: Bearer ' + 'abcdefghijklmnop123'
        cmd = (f'curl -H "{auth_header}" -d token=s3cr3tvalue '
               f'https://api.telegram.org/bot{fake_bot_token}/getMe ' + 'x' * 200)
        self.run_hook(tool_input={'command': cmd})
        text = Mock.calls[0][1]['text']
        for leak in ['abcdefghijklmnop123', 's3cr3tvalue', 'AAHfiqksKZ8']:
            self.assertNotIn(leak, text)
        step = text.splitlines()[-1]
        self.assertLessEqual(len(step), 2 + 80)

    def test_finds_turn_behind_huge_tool_results(self):
        # Turn start sits behind ~6MB of tool output: past the first 256KB scan window.
        self.write(channel_turn(DM, 60), *[tool_result(600_000) for _ in range(10)])
        p, dt = self.run_hook()
        self.assertEqual(len(Mock.calls), 1)
        self.assertLess(dt, 2)

    def test_non_pretooluse_event_ignored(self):
        self.write(channel_turn(DM, 70))
        payload = json.dumps({'hook_event_name': 'Stop', 'transcript_path': self.transcript})
        self.run_hook(raw_stdin=payload)
        self.assertEqual(Mock.calls, [])


if __name__ == '__main__':
    unittest.main()
