"""Fresh shared-plan quota, with no inference or credential handling."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from relay.application import Application
from relay.limits import claude_usage_status_reading, read_claude_usage_status

REPORT = {'type':'result','subtype':'success','local_command':'usage','is_error':False,
          'num_turns':0,'total_cost_usd':0,
          'result':'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 44% used · resets Nov 1 at 6:20pm (Asia/Almaty)\nCurrent week (all models): 74% used · resets Nov 2 at 4am (Asia/Almaty)\n\nLast 7d · 514 requests'}

class ClaudeUsageStatusTests(unittest.TestCase):
    def test_account_used_percentages_are_converted_once(self):
        reading=claude_usage_status_reading(REPORT)
        self.assertEqual(reading['session']['left'],56)
        self.assertEqual(reading['week']['left'],26)
        self.assertEqual(reading['session']['reset_label'],'Nov 1 at 6:20pm (Asia/Almaty)')

    def test_model_answers_errors_and_unverified_results_are_not_quotas(self):
        for updates in [{'local_command':None},{'num_turns':1},{'total_cost_usd':0.01},{'is_error':True},{'result':'Current session: 101% used'},{'result':'Current week (Sonnet): 74% used'}]:
            self.assertIsNone(claude_usage_status_reading({**REPORT,**updates}))
        self.assertIsNone(claude_usage_status_reading(None))
        reading=claude_usage_status_reading({**REPORT,'result':'Current week (all models): 74% used'})
        self.assertEqual(set(reading),{'week'})

    def test_status_command_is_isolated_and_contains_no_model_prompt(self):
        calls=[]
        def run(args,**kwargs):
            calls.append((args,kwargs))
            self.assertTrue(Path(kwargs['cwd']).is_dir())
            self.assertEqual(list(Path(kwargs['cwd']).iterdir()),[])
            return type('Result',(),{'returncode':0,'stdout':json.dumps(REPORT)})()
        with patch.dict(os.environ,{'RELAY_NO_CLAUDE_USAGE_POLL':'','CLAUDECODE':'nested'}):
            self.assertEqual(read_claude_usage_status('/bin/claude',run=run)['session']['left'],56)
        args,kwargs=calls[0]
        self.assertEqual(args[:4],['/bin/claude','-p','/usage','--output-format'])
        self.assertIn('--restricted',args)
        self.assertEqual(args[args.index('--tools')+1],'')
        self.assertEqual(args[args.index('--setting-sources')+1],'')
        self.assertNotIn('input',kwargs)
        self.assertNotIn('CLAUDECODE',kwargs['env'])

    def test_missing_cli_unsupported_output_and_failures_produce_no_current_reading(self):
        def fail(*args,**kwargs):raise OSError('missing')
        with patch.dict(os.environ,{'RELAY_NO_CLAUDE_USAGE_POLL':''}):
            self.assertIsNone(read_claude_usage_status('/no/cli',run=fail))
            self.assertIsNone(read_claude_usage_status('/bin/cli',run=lambda *a,**k:type('Result',(),{'returncode':0,'stdout':'not-json'})()))

    def test_app_refreshes_each_minute_instead_of_waiting_fifteen(self):
        with tempfile.TemporaryDirectory() as folder:
            app=Application(folder,Path(folder)/'data')
            now=[1000];jobs=[]
            app.limits.clock=lambda:now[0]
            app.limits.start=jobs.append
            app.limits.executable=lambda _:'/bin/claude'
            app.limits.next['codex']=float('inf')
            app.limits._store('claude',claude_usage_status_reading(REPORT),source='claude-usage-command')
            now[0]=1059;app.limits.snapshot();self.assertEqual(jobs,[])
            now[0]=1061;app.limits.snapshot();self.assertEqual([job.args[0] for job in jobs],['claude'])
            self.assertEqual(app.limits.snapshot()['claude']['source'],'claude-usage-command')
