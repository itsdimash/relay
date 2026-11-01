import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from relay.application import Application
from relay.desktop import DesktopCompanion, read_claude_usage


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.app = Application(self.home, self.home / 'relay-data')
        self.app.limits.readers['claude'] = lambda _: None
        self.monitor = self.app.desktop = DesktopCompanion(self.app, home=self.home)
        self.monitor.bind('http://127.0.0.1:8765')
        self.results = {}
        self.workers = []

    def tearDown(self):
        self.monitor.shutdown()
        for worker in self.workers:
            worker.join(3)
        self.temp.cleanup()

    def pending(self, provider='codex', use_id='call-1'):
        payload = {'hook_event_name': 'PermissionRequest', 'session_id': 's1', 'cwd': '/project',
                   'tool_name': 'Bash', 'tool_use_id': use_id, 'tool_input': {'command': 'echo test', 'secret': 'not retained'}}
        worker = threading.Thread(target=lambda: self.results.update({use_id: self.monitor.receive(provider, self.monitor.token, payload, timeout=3)}))
        self.workers.append(worker); worker.start()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with self.monitor.lock:
                requests = [r for s in self.monitor.hook_rows.values() for r in s['requests'] if r['tool_use_id'] == use_id]
            if requests: return requests[0]['id']
            time.sleep(.01)
        self.fail('No approval request arrived')

    def test_install_preserves_existing_hooks_and_disconnect_only_removes_relay(self):
        path = self.home / '.claude/settings.json'; path.parent.mkdir()
        existing = {'model': 'opus', 'hooks': {'PreToolUse': [{'hooks': [{'type':'command', 'command':'existing-tool'}]}]}}
        path.write_text(json.dumps(existing))
        self.monitor.connect('claude', True)
        self.assertTrue(self.monitor.installed('claude'))
        saved = json.loads(path.read_text())
        self.assertEqual(saved['model'], 'opus')
        self.assertEqual(saved['hooks']['PreToolUse'][0]['hooks'][0]['command'], 'existing-tool')
        self.assertNotIn(self.monitor.token, path.read_text())
        self.assertEqual(self.monitor._curl_path('claude').stat().st_mode & 0o777, 0o600)
        self.monitor.connect('claude', False)
        self.assertFalse(self.monitor.installed('claude'))
        self.assertEqual(json.loads(path.read_text()), existing)

    def test_codex_setup_requires_normal_provider_review(self):
        result = self.monitor.connect('codex', True)
        self.assertTrue(result['requires_review'])
        settings = json.loads((self.home / '.codex/hooks.json').read_text())
        self.assertNotIn('dangerously', json.dumps(settings))
        self.assertEqual(len(settings['hooks']['PermissionRequest']), 1)
        self.monitor.connect('codex', True)
        self.assertEqual(len(json.loads((self.home / '.codex/hooks.json').read_text())['hooks']['PermissionRequest']), 1)

    def test_approve_reject_fallback_and_stale_decisions(self):
        for provider, decision in [('codex','approve'),('claude','reject'),('codex','app')]:
            use_id = provider + decision
            rid = self.pending(provider, use_id)
            snapshot = self.monitor.snapshot()
            self.assertNotIn('not retained', json.dumps(snapshot))
            self.monitor.decide(rid, decision)
            self.workers[-1].join(2)
            result = self.results[use_id]
            if decision == 'app': self.assertEqual(result, {})
            else: self.assertEqual(result['hookSpecificOutput']['decision']['behavior'], 'allow' if decision=='approve' else 'deny')
            with self.assertRaises(ValueError): self.monitor.decide(rid, 'approve')

    def test_expiration_and_shutdown_return_no_decision_to_the_app(self):
        result = self.monitor.receive('codex', self.monitor.token, {'hook_event_name':'PermissionRequest','session_id':'x'}, timeout=0)
        self.assertEqual(result, {})
        self.assertEqual(self.monitor.pending, {})
        rid = self.pending()
        self.monitor.shutdown(); self.workers[-1].join(2)
        self.assertEqual(self.results['call-1'], {})

    def test_post_tool_event_only_clears_the_matching_request(self):
        a = self.pending(use_id='a'); b = self.pending(use_id='b')
        self.monitor.receive('codex',self.monitor.token,{'hook_event_name':'PostToolUse','session_id':'s1','tool_use_id':'a','tool_name':'Bash'})
        self.workers[0].join(2)
        self.assertEqual(self.results['a'], {})
        self.assertFalse(self.monitor.pending[b]['event'].is_set())
        self.monitor.decide(b,'reject')

    def test_invalid_credentials_and_events_are_rejected(self):
        for provider, token, payload in [('codex','wrong',{}),('bad',self.monitor.token,{}),('claude',self.monitor.token,{'hook_event_name':'PreToolUse'})]:
            with self.assertRaises(ValueError): self.monitor.receive(provider,token,payload,0)

    def test_codex_desktop_discovery_and_turn_state_are_read_only(self):
        root = self.home / '.codex'; (root/'sessions').mkdir(parents=True)
        log = root/'sessions/test.jsonl'
        now = time.time()
        log.write_text('\n'.join(json.dumps({'timestamp': now, 'type':'event_msg', 'payload':payload}) for payload in [
            {'type':'task_started'}, {'type':'token_count','rate_limits':{'primary':{'used_percent':25,'window_minutes':300,'resets_at':now+1000}}}])+'\n')
        connection = sqlite3.connect(root/'state_5.sqlite')
        connection.execute('create table threads (id text,title text,cwd text,rollout_path text,updated_at integer,source text,archived integer,originator text)')
        for identifier, source in [('desktop','vscode'),('cli','cli')]:
            connection.execute('insert into threads values (?,?,?,?,?,?,?,?)',(identifier,'Existing app task','/project',str(log),now,source,0,'Codex Desktop'))
        connection.commit(); connection.close()
        before=log.read_bytes()
        with patch('subprocess.Popen') as spawn:
            self.monitor.scan(); self.app.limits.snapshot(); spawn.assert_not_called()
        rows=self.monitor.snapshot()['sessions']
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['status'],'working')
        self.assertEqual(self.app.limits.data['codex']['session']['left'],75)
        self.assertEqual(log.read_bytes(),before)
        with log.open('a') as handle:handle.write(json.dumps({'type':'event_msg','payload':{'type':'task_complete'}})+'\n')
        self.monitor.scan();self.assertEqual(self.monitor.snapshot()['sessions'][0]['status'],'finished')

    def test_claude_desktop_metadata_and_usage_without_model_requests(self):
        root=self.home/'Library/Application Support/Claude'
        sessions=root/'claude-code-sessions/account/organization';sessions.mkdir(parents=True)
        now=time.time()
        (sessions/'local_x.json').write_text(json.dumps({'cliSessionId':'native-id','title':'Original app task','cwd':'/project','lastActivityAt':now*1000,'lastTurnEdgeAt':now*1000,'latestUserFrameAt':(now-10)*1000}))
        (root/'plan-usage-history.json').write_text(json.dumps({'samples':[{'t':now*1000,'u':{'fh':20,'sd':67}}]}))
        self.monitor.scan();rows=self.monitor.snapshot()['sessions']
        self.assertEqual(rows[0]['provider'],'claude');self.assertEqual(rows[0]['status'],'finished')
        self.assertEqual(self.app.limits.data['claude']['week']['left'],33)
        self.assertEqual(self.app.limits.data['claude']['seen_at'],int(now))
        self.assertIsNone(self.app.limits.data['claude']['session']['resets_at'])

    def test_claude_screenshot_usage_is_converted_once_and_old_samples_stay_old(self):
        root = self.home / 'Library/Application Support/Claude'
        root.mkdir(parents=True)
        now = time.time()
        path = root / 'plan-usage-history.json'
        def write_usage(observed, used_session, used_week):
            path.write_text(json.dumps({'samples': [{'t': observed * 1000, 'u': {'fh': used_session, 'sd': used_week}}]}))
        write_usage(now - 1800, 26, 71)
        self.monitor.scan()
        reading = self.app.limits.snapshot()['claude']
        self.assertTrue(reading['stale'])
        self.assertEqual(reading['seen_at'], int(now - 1800))
        self.monitor.scan()
        self.assertEqual(self.app.limits.data['claude']['seen_at'], int(now - 1800))
        write_usage(now, 44, 74)
        self.monitor.scan()
        reading = self.app.limits.snapshot()['claude']
        self.assertFalse(reading['stale'])
        self.assertEqual(reading['session']['left'], 56)
        self.assertEqual(reading['week']['left'], 26)
        self.assertEqual(reading['source'], 'claude-desktop-history')

    def test_only_sessions_active_within_twenty_minutes_are_visible(self):
        current = [100000.0]
        self.monitor.clock = lambda: current[0]
        self.monitor.next_scan = float('inf')
        def row(identifier, age, source='desktop'):
            return {'id': identifier, 'provider': identifier.split(':')[0], 'updated': current[0] - age,
                    'status': 'finished', 'activity': 'Turn finished', 'source': source, 'requests': []}
        self.monitor.rows = {
            'codex:recent': row('codex:recent', 1199),
            'codex:boundary': row('codex:boundary', 1200),
            'codex:expired': row('codex:expired', 1201),
            'claude:old': row('claude:old', 45 * 3600),
            'claude:resumed': row('claude:resumed', 10000),
        }
        self.monitor.hook_rows = {
            'claude:hook': row('claude:hook', 15 * 60, 'hook'),
            'claude:resumed': row('claude:resumed', 1199, 'hook'),
        }
        self.assertEqual({r['id'] for r in self.monitor.snapshot()['sessions']},
                         {'codex:recent', 'codex:boundary', 'claude:hook', 'claude:resumed'})
        current[0] += 2
        self.assertEqual([r['id'] for r in self.monitor.snapshot()['sessions']], ['claude:hook'])
        current[0] += 300
        self.assertEqual(self.monitor.snapshot()['sessions'], [])

    def test_office_has_no_task_form_or_session_launch_endpoint(self):
        source=(Path(__file__).parents[1]/'static/js/desktop-sessions.js').read_text()
        self.assertNotIn("element('textarea'",source)
        self.assertNotIn('/api/direct',source)
        self.assertNotIn('turn/start',source)
        self.assertIn('Answer in app',source)

if __name__=='__main__':unittest.main()
