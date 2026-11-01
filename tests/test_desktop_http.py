"""Real original-app hook transport, isolated from user settings and model calls."""
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from relay.application import Application
from relay.desktop import DesktopCompanion

class DesktopHttpTests(unittest.TestCase):
 def test_hook_roundtrip_and_offline_fallback(self):
  with tempfile.TemporaryDirectory() as folder:
   home=Path(folder);app=Application(home,home/'relay');app.desktop=DesktopCompanion(app,home=home)
   server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler);server.daemon_threads=True
   worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
   url=f'http://127.0.0.1:{server.server_port}';app.desktop.bind(url)
   try:
    for provider,decision,expected in [('codex','approve','allow'),('claude','reject','deny'),('codex','app',None)]:
     app.desktop.connect(provider,True)
     process=subprocess.Popen(['/bin/sh','-c',app.desktop._command(provider)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
     payload={'hook_event_name':'PermissionRequest','session_id':'original-app','tool_name':'Bash','tool_input':{'command':'echo simulated'}}
     process.stdin.write(json.dumps(payload));process.stdin.close()
     deadline=time.monotonic()+3
     while time.monotonic()<deadline:
      with app.desktop.lock:pending=list(app.desktop.pending)
      if pending:break
      time.sleep(.01)
     self.assertTrue(pending)
     request=urllib.request.Request(url+'/api/desktop/decide',data=json.dumps({'request_id':pending[0],'decision':decision}).encode(),headers={'X-Relay-Token':app.TOKEN,'Content-Type':'application/json'})
     with urllib.request.urlopen(request,timeout=3) as response:self.assertTrue(json.load(response)['ok'])
     result=json.loads(process.stdout.read());process.wait(3);process.stdout.close();process.stderr.close()
     if expected:self.assertEqual(result['hookSpecificOutput']['decision']['behavior'],expected)
     else:self.assertEqual(result,{})
    request=urllib.request.Request(url+'/api/desktop/event/codex',data=json.dumps(payload).encode(),headers={'X-Relay-Desktop-Token':app.TOKEN})
    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=3)
    self.assertEqual(error.exception.code,400);error.exception.close()
    with urllib.request.urlopen(url+'/api/desktop',timeout=3) as response:self.assertNotIn(app.desktop.token,response.read().decode())
   finally:
    app.desktop.shutdown();server.shutdown();server.server_close();worker.join(3)
   result=subprocess.run(['/bin/sh','-c',app.desktop._command('codex')],input=json.dumps(payload),capture_output=True,text=True,timeout=3)
   self.assertEqual(result.returncode,0);self.assertEqual(json.loads(result.stdout),{})
