import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from relay import limits
from relay.limits import Limits, claude_reading, codex_reading, read_claude_limits, read_codex_limits

ROOT = Path(__file__).parents[1]

# A real event from `claude -p --output-format stream-json --verbose`.
CLAUDE_EVENT = {
    'type': 'rate_limit_event',
    'rate_limit_info': {
        'status': 'allowed_warning', 'resetsAt': 1792969200, 'rateLimitType': 'seven_day', 'utilization': 0.91,
        'unifiedWindows': {'five_hour': {'utilization': 0.5, 'resetsAt': 1792894800},
                           'seven_day': {'utilization': 0.91, 'resetsAt': 1792969200}},
    },
}


class ReadingTests(unittest.TestCase):
    def test_claude_event_gives_percent_left_for_both_windows(self):
        windows = claude_reading(CLAUDE_EVENT)
        self.assertEqual(windows['session'], {'left': 50, 'resets_at': 1792894800})
        self.assertEqual(windows['week'], {'left': 9, 'resets_at': 1792969200})

    def test_utilization_may_be_a_fraction_or_a_percent(self):
        self.assertEqual(limits._left(0.25), 75)
        self.assertEqual(limits._left(25), 75)
        self.assertEqual(limits._left(1.0), 0)
        self.assertEqual(limits._left(100), 0)
        self.assertEqual(limits._left(150), 0)
        self.assertIsNone(limits._left('x'))
        self.assertIsNone(limits._left(-1))

    def test_codex_used_percent_is_a_plain_percent(self):
        # The real answer from `codex app-server`: 1 means 1% used, not 100%.
        real = {'rateLimits': {'primary': {'usedPercent': 1, 'windowDurationMins': 300, 'resetsAt': 1792902732},
                               'secondary': {'usedPercent': 51, 'windowDurationMins': 10080, 'resetsAt': 1793382131}}}
        windows = codex_reading(real)
        self.assertEqual(windows['session']['left'], 99)
        self.assertEqual(windows['week']['left'], 49)
        self.assertEqual(codex_reading({'primary': {'usedPercent': 0, 'windowDurationMins': 300}})['session']['left'], 100)
        self.assertEqual(codex_reading({'primary': {'usedPercent': 100, 'windowDurationMins': 300}})['session']['left'], 0)

    def test_an_event_without_numbers_is_ignored(self):
        self.assertIsNone(claude_reading({'type': 'rate_limit_event'}))
        self.assertIsNone(claude_reading({'rate_limit_info': {'status': 'allowed'}}))
        self.assertIsNone(claude_reading(None))

    def test_older_claude_shape_with_one_window(self):
        event = {'rate_limit_info': {'rateLimitType': 'five_hour', 'utilization': 0.2, 'resetsAt': 5}}
        self.assertEqual(claude_reading(event), {'session': {'left': 80, 'resets_at': 5}})

    def test_codex_windows_are_told_apart_by_their_length(self):
        result = {'rateLimits': {'primary': {'usedPercent': 12, 'windowDurationMins': 300, 'resetsAt': 100},
                                 'secondary': {'usedPercent': 40, 'windowDurationMins': 10080, 'resetsAt': 200}}}
        windows = codex_reading(result)
        self.assertEqual(windows['session'], {'left': 88, 'resets_at': 100})
        self.assertEqual(windows['week'], {'left': 60, 'resets_at': 200})
        # The same without the wrapper, and a weekly-only account.
        self.assertEqual(codex_reading({'primary': {'usedPercent': 10, 'windowDurationMins': 10080}})['week']['left'], 90)
        self.assertIsNone(codex_reading({'primary': None}))
        self.assertIsNone(codex_reading('nope'))


class FakeServer:
    """Stands in for `codex app-server`: answers the rate-limit question the way the real one does."""

    def __init__(self, answer, errors=False):
        read, write = os.pipe()
        self.stdout = os.fdopen(read, 'r')
        self.out = os.fdopen(write, 'w')
        self.answer, self.errors, self.killed, self.seen = answer, errors, False, []
        self.stdin = self

    def write(self, text):
        message = json.loads(text)
        self.seen.append(message)
        if message.get('id') == 1:
            self.out.write(json.dumps({'id': 1, 'result': {}}) + '\n')
        if message.get('id') == 2:
            body = {'id': 2, 'error': {'message': 'not signed in'}} if self.errors else {'id': 2, 'result': self.answer}
            self.out.write(json.dumps(body) + '\n')
        self.out.flush()

    def flush(self):
        pass

    def close(self):
        pass

    def kill(self):
        self.killed = True
        self.out.close()
        self.stdout.close()

    def wait(self, timeout=None):
        return 0


class CodexQuestionTests(unittest.TestCase):
    def test_asks_in_order_and_reads_the_answer(self):
        server = FakeServer({'rateLimits': {'primary': {'usedPercent': 30, 'windowDurationMins': 300, 'resetsAt': 9}}})
        windows = read_codex_limits('/bin/codex', timeout=3, popen=lambda *a, **k: server)
        self.assertEqual(windows, {'session': {'left': 70, 'resets_at': 9}})
        self.assertEqual([m.get('method') for m in server.seen], ['initialize', 'initialized', 'account/rateLimits/read'])
        self.assertTrue(server.killed)

    def test_an_error_answer_gives_nothing(self):
        server = FakeServer(None, errors=True)
        self.assertIsNone(read_codex_limits('/bin/codex', timeout=3, popen=lambda *a, **k: server))

    def test_a_missing_program_gives_nothing(self):
        def broken(*a, **k):
            raise OSError('no such file')
        self.assertIsNone(read_codex_limits('/nope', popen=broken))


class LimitsStoreTests(unittest.TestCase):
    def make(self, folder, now=1000, codex=None, claude=None, binary='/bin/tool'):
        self.now = now
        self.jobs = {'claude': [], 'codex': []}
        self.asked = []

        def reader(tool, answer):
            def read(path):
                self.asked.append(tool)
                return answer
            return read

        def start(job):
            self.jobs[job.args[0]].append(job)

        return Limits(Path(folder) / 'limits.json', lambda name: binary, clock=lambda: self.now,
                      read_codex=reader('codex', codex), read_claude=reader('claude', claude), start=start)

    def test_a_claude_reading_is_kept_and_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, now=1792890000)
            store.record_claude(CLAUDE_EVENT)
            again = self.make(folder, now=1792890060)
            shot = again.snapshot()
            self.assertEqual(shot['claude']['session']['left'], 50)
            self.assertEqual(shot['claude']['week']['left'], 9)
            self.assertEqual(shot['claude']['seen_at'], 1792890000)

    def test_claude_percentages_expire_without_retimestamping_the_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, now=1000)
            store._store('claude', {'session': {'left': 74, 'resets_at': 10000},
                                    'week': {'left': 29, 'resets_at': 20000}})
            self.now = 1120
            self.assertFalse(store.snapshot()['claude']['stale'])
            self.now = 1121
            self.assertTrue(store.snapshot()['claude']['stale'])
            self.assertEqual(store.snapshot()['claude']['seen_at'], 1000)
            restored = self.make(folder, now=2873)
            self.assertTrue(restored.snapshot()['claude']['stale'])
            self.assertEqual(restored.snapshot()['claude']['seen_at'], 1000)

    def test_no_reading_yet_is_none(self):
        with tempfile.TemporaryDirectory() as folder:
            shot = self.make(folder).snapshot()
            self.assertIsNone(shot['claude'])
            self.assertIsNone(shot['codex'])

    def test_a_window_that_has_reset_needs_a_fresh_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, now=1792890000)
            store.record_claude(CLAUDE_EVENT)
            self.now = 1792894801  # one second after the 5-hour window reset
            shot = store.snapshot()
            self.assertNotIn('session', shot['claude'])
            self.assertEqual(shot['claude']['week']['left'], 9)

    def test_asking_never_waits_and_each_tool_refreshes_in_the_background(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, codex={'session': {'left': 70, 'resets_at': 99999}})
            first = store.snapshot()
            self.assertIsNone(first['codex'])   # nothing yet; the answer is on its way
            self.assertEqual(self.asked, [])    # asking the screens did not run any tool
            self.assertEqual(len(self.jobs['codex']), 1)
            store.snapshot()
            self.assertEqual(len(self.jobs['codex']), 1)      # one refresh at a time
            self.jobs['codex'][0]()
            self.assertEqual(store.snapshot()['codex']['session']['left'], 70)
            self.assertEqual(len(self.jobs['codex']), 1)      # and not again right away
            self.now += limits.CODEX_REFRESH_SECONDS + 1
            store.snapshot()
            self.assertEqual(len(self.jobs['codex']), 2)

    def test_claude_is_asked_when_there_is_no_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, claude={'session': {'left': 40, 'resets_at': 99999}})
            store.snapshot()
            self.assertEqual(len(self.jobs['claude']), 1)
            self.jobs['claude'][0]()
            self.assertEqual(self.asked, ['claude'])
            self.assertEqual(store.snapshot()['claude']['session']['left'], 40)

    def test_claude_is_not_asked_while_a_reading_from_a_task_is_fresh(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, now=1792890000)
            store.record_claude(CLAUDE_EVENT)
            self.now += 60
            store.snapshot()
            self.assertEqual(self.jobs['claude'], [])
            self.now += limits.CLAUDE_REFRESH_SECONDS
            store.snapshot()
            self.assertEqual(len(self.jobs['claude']), 1)

    def test_a_failed_question_backs_off(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, codex=None)
            store.snapshot()
            self.jobs['codex'][0]()
            self.now += limits.CODEX_REFRESH_SECONDS + 1
            store.snapshot()
            self.assertEqual(len(self.jobs['codex']), 1)      # still waiting out the retry delay
            self.now += limits.CODEX_RETRY_SECONDS
            store.snapshot()
            self.assertEqual(len(self.jobs['codex']), 2)

    def test_a_tool_that_is_not_installed_is_never_asked(self):
        with tempfile.TemporaryDirectory() as folder:
            store = self.make(folder, binary=None)
            store.snapshot()
            for tool in ('claude', 'codex'):
                self.jobs[tool][0]()
            self.assertEqual(self.asked, [])
            self.assertIsNone(store.snapshot()['codex'])

    def test_a_broken_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'limits.json').write_text('{not json')
            self.assertIsNone(self.make(folder).snapshot()['claude'])


class ClaudeQuestionTests(unittest.TestCase):
    def fake_run(self, stdout, calls):
        def run(args, **kwargs):
            calls.append((args, kwargs))
            return type('Result', (), {'stdout': stdout, 'returncode': 0})()
        return run

    def test_the_question_is_small_and_reads_the_reported_usage(self):
        calls = []
        stdout = json.dumps({'type': 'system'}) + '\n' + json.dumps(CLAUDE_EVENT) + '\n' + json.dumps({'type': 'result'}) + '\n'
        windows = read_claude_limits('/bin/claude', run=self.fake_run(stdout, calls))
        self.assertEqual(windows['session']['left'], 50)
        args, kwargs = calls[0]
        self.assertIn('haiku', args)                 # the cheapest model
        self.assertEqual(args[args.index('--tools') + 1], 'Read')   # no way to change anything
        self.assertIn('--restricted', args)
        self.assertIn('--strict-mcp-config', args)
        self.assertNotIn('CLAUDECODE', kwargs['env'])
        self.assertTrue(os.path.basename(kwargs['cwd']).startswith('relay-limits-'))  # an empty folder, not a project

    def test_no_report_or_a_failure_gives_nothing(self):
        self.assertIsNone(read_claude_limits('/bin/claude', run=self.fake_run('{"type":"result"}\n', [])))

        def broken(*a, **k):
            raise OSError('no such file')
        self.assertIsNone(read_claude_limits('/nope', run=broken))

    def test_it_can_be_switched_off(self):
        calls = []
        os.environ['RELAY_NO_CLAUDE_PROBE'] = '1'
        try:
            self.assertIsNone(read_claude_limits('/bin/claude', run=self.fake_run('', calls)))
        finally:
            del os.environ['RELAY_NO_CLAUDE_PROBE']
        self.assertEqual(calls, [])


class WiringTests(unittest.TestCase):
    def test_the_engine_records_claude_readings_and_serves_the_numbers(self):
        processes = (ROOT / 'relay' / 'processes.py').read_text()
        http = (ROOT / 'relay' / 'http.py').read_text()
        self.assertIn("typ == 'rate_limit_event'", processes)
        self.assertIn('self.app.limits.record_claude(event)', processes)
        self.assertIn("path == '/api/limits'", http)
        self.assertIn("data['limits'] = self.app.limits.snapshot()", http)
        self.assertIn("'limits'", http)  # the shared page module is served

    def test_both_screens_show_the_numbers(self):
        notch = (ROOT / 'static' / 'notch.js').read_text()
        teams = (ROOT / 'static' / 'js' / 'teams.js').read_text()
        html = (ROOT / 'static' / 'notch.html').read_text()
        index = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn("from './js/limits.js'", notch)
        self.assertIn('renderLimits(data.limits)', notch)
        self.assertIn('id="limits"', html)
        self.assertIn("from './limits.js'", teams)
        self.assertIn("request('/api/limits')", teams)
        self.assertIn('id="usageLeft"', index)
        self.assertTrue((ROOT / 'static' / 'js' / 'limits.js').is_file())
