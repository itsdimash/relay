"""Office opens on active work without overriding a deliberate tab choice."""
from pathlib import Path
import json
import shutil
import subprocess
import unittest

@unittest.skipUnless(shutil.which('node'), 'Node is required')
class OfficeSelectionTests(unittest.TestCase):
    def test_priority_manual_selection_and_reopening(self):
        source=(Path(__file__).parents[1]/'static/js/desktop-sessions.js').read_text()
        script='''
import assert from 'node:assert/strict';
const { preferredOfficeProvider, createDesktopSessions } = await import('data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64'));
const codex={id:'cx',provider:'codex',status:'working',title:'Codex task',project:'/test',updated:Date.now()/1000,requests:[]};
const claude={...codex,id:'cl',provider:'claude',title:'Claude task'};
assert.equal(preferredOfficeProvider([codex],null),'codex');
assert.equal(preferredOfficeProvider([codex,claude],null),'claude');
assert.equal(preferredOfficeProvider([claude,codex],{running:true}),'team');
assert.equal(preferredOfficeProvider([claude,codex],{running:true,paused:true}),'claude');
assert.equal(preferredOfficeProvider([{...claude,status:'needs_approval'},codex],null),'claude');
assert.equal(preferredOfficeProvider([{...claude,status:'finished'},codex],null),'codex');
assert.equal(preferredOfficeProvider([{...claude,status:'unknown'}],null,'codex'),'codex');
class Element extends EventTarget {
 constructor(tag) { super(); this.tagName=tag; this.children=[]; this.attributes={}; this.dataset={}; }
 append(...children) { this.children.push(...children); }
 replaceChildren(...children) { this.children=children; }
 setAttribute(key,value) { this.attributes[key]=String(value); }
 removeAttribute(key) { delete this.attributes[key]; }
 toggleAttribute(key,on) { if(on)this.setAttribute(key,'');else this.removeAttribute(key); }
 querySelectorAll() { return []; }
 click() { this.dispatchEvent(new Event('click')); }
}
globalThis.document={createElement:tag=>new Element(tag)};
const host=new Element('div');let selectedProvider=null,openCalls=0;
const office=createDesktopSessions(host,{post:async()=>({}),changed:async()=>{},open:()=>openCalls++,selected:provider=>selectedProvider=provider,attention:()=>{}});
office.update({sessions:[codex]});assert.equal(selectedProvider,'codex');
office.update({sessions:[codex,claude]});assert.equal(selectedProvider,'claude');
const modes=host.children[0].children;
modes.find(button=>button.textContent==='Codex app').click();assert.equal(selectedProvider,'codex');
office.update({sessions:[claude,codex]},{running:true});assert.equal(selectedProvider,'codex');
office.activate();assert.equal(selectedProvider,'team');
office.update({sessions:[claude,codex]},{running:false});assert.equal(selectedProvider,'claude');
modes.find(button=>button.textContent==='Codex app').click();
office.activate();assert.equal(selectedProvider,'claude');
office.update({sessions:[codex]});assert.equal(selectedProvider,'codex');
assert.equal(openCalls,0,'Choosing an Office view must not launch or focus the native app');
'''.replace('SOURCE',json.dumps(source))
        result=subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
