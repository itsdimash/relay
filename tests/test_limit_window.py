"""Regression: a low weekly allowance must not replace the selected 5-hour meter."""
from pathlib import Path
import json
import shutil
import subprocess
import unittest

@unittest.skipUnless(shutil.which('node'), 'Node is required')
class LimitWindowTests(unittest.TestCase):
    def test_only_the_selected_window_controls_the_readout_and_colour(self):
        source=(Path(__file__).parents[1]/'static/js/limits.js').read_text()
        script='''
import assert from 'node:assert/strict';
const { describeLimit } = await import('data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64'));
const reading={seen_at:1000,session:{left:80,resets_at:5000},week:{left:8,resets_at:9000}};
const short=describeLimit(reading,1000,'session');
assert.equal(short.tightest,80);assert.equal(short.level,'ok');assert.equal(short.text,'80% left');
assert.match(short.title,/5-hour/);assert.doesNotMatch(short.title,/Weekly/);
const weekly=describeLimit(reading,1000,'week');
assert.equal(weekly.tightest,8);assert.equal(weekly.level,'critical');assert.equal(weekly.text,'8% left');
assert.match(weekly.title,/Weekly/);assert.doesNotMatch(weekly.title,/5-hour/);
assert.equal(describeLimit({week:reading.week},1000,'session'),null);
assert.equal(describeLimit({session:reading.session},1000,'week'),null);
assert.equal(describeLimit(reading,1000).tightest,8);
const old={seen_at:1000,stale:true,session:{left:74},week:{left:29}};
for (const period of ['session','week']) {
 const stale=describeLimit(old,2873,period);
 assert.equal(stale.level,'stale');assert.equal(stale.text,'Out of date');assert.equal(stale.tightest,0);
 assert.doesNotMatch(stale.text,/74|29/);assert.match(stale.title,/31 min ago/);
}

'''.replace('SOURCE',json.dumps(source))
        result=subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
