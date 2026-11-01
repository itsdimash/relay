"""Companion for the original desktop apps. Never starts a model turn or resumes a thread.

Read-only session discovery works without setup. Optional lifecycle hooks report live
activity and relay an explicit human approval; a missing Relay falls back to the app.
Provider-owned metadata formats are best effort and deliberately bounded/cached.
"""
import copy
import datetime as dt
import hmac
import json
import os
from pathlib import Path
import secrets
import shlex
import sqlite3
import threading
import time

from .limits import codex_reading

EVENTS = ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd')
LABELS = {'codex': 'Codex', 'claude': 'Claude Code'}
RECENT_ACTIVITY_SECONDS = 20 * 60


def stamp(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 100000000000 else float(value)
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError):
        return 0


def read_json(path):
    with Path(path).open() as handle:
        return json.load(handle)


def tail(path, size=384000):
    """Read a bounded suffix; ignore a partial first/last record during provider writes."""
    path = Path(path)
    with path.open('rb') as handle:
        offset = max(0, path.stat().st_size - size)
        handle.seek(offset)
        if offset:
            handle.readline()
        for line in handle:
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    yield value
            except (ValueError, UnicodeError):
                continue


def read_claude_usage(binary=None, *, home=None):
    """Claude desktop's local percentage history, without an inference/credential request.

    This desktop-owned cache has no reset timestamps. Omit those instead of inventing
    them. A format change produces no reading; live task events remain authoritative.
    """
    try:
        path = (Path(home) if home else Path.home()) / 'Library/Application Support/Claude/plan-usage-history.json'
        data = read_json(path)
        latest = max(data.get('samples', []), key=lambda s: s.get('t', 0))
        if time.time() - stamp(latest.get('t')) > 86400:
            return None
        result = {}
        for source, key in [('fh', 'session'), ('sd', 'week')]:
            used = latest.get('u', {}).get(source)
            if type(used) in (int, float) and 0 <= used <= 100:
                result[key] = {'left': round(100 - used), 'resets_at': None}
        return (result, stamp(latest.get('t'))) if result else None
    except (OSError, ValueError, TypeError, AttributeError):
        return None


class DesktopCompanion:
    def __init__(self, app, home=None, clock=time.time):
        self.app = app
        self.home = Path(home) if home else Path.home()
        self.clock = clock
        self.lock = threading.RLock()
        self.rows = {}
        self.hook_rows = {}
        self.pending = {}
        self.token = secrets.token_urlsafe(32)
        self.base_url = None
        self.next_scan = 0
        self.scanning = False
        self.problems = {}
        self.last_hook = {}

    def _config_path(self, provider):
        return self.home / ('.codex/hooks.json' if provider == 'codex' else '.claude/settings.json')

    def _curl_path(self, provider):
        return self.app.DATA / f'desktop-{provider}.curl'

    def _command(self, provider):
        # No token in provider settings, command arguments, or returned UI state.
        return '/usr/bin/curl --config ' + shlex.quote(str(self._curl_path(provider))) + ' --data-binary @- 2>/dev/null || printf "{}"'

    def _ours(self, hook, provider):
        return isinstance(hook, dict) and hook.get('command') == self._command(provider)

    def installed(self, provider):
        try:
            settings = read_json(self._config_path(provider))
            return any(self._ours(h, provider) for group in settings.get('hooks', {}).get('PermissionRequest', []) for h in group.get('hooks', []))
        except (OSError, ValueError, AttributeError, TypeError):
            return False

    def bind(self, base_url):
        self.base_url = base_url
        for provider in LABELS:
            if self.installed(provider):
                self._write_curl(provider)

    def _write_curl(self, provider):
        if not self.base_url:
            raise ValueError('Relay is not ready to connect yet.')
        self.app.DATA.mkdir(parents=True, exist_ok=True)
        path = self._curl_path(provider)
        content = '\n'.join(['url = ' + json.dumps(self.base_url + '/api/desktop/event/' + provider),
                             'header = ' + json.dumps('X-Relay-Desktop-Token: ' + self.token),
                             'header = "Content-Type: application/json"', 'silent', 'show-error', 'fail',
                             'connect-timeout = 1', 'max-time = 125', ''])
        temporary = path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
        temporary.replace(path)

    def connect(self, provider, enabled):
        if provider not in LABELS or type(enabled) is not bool:
            raise ValueError('Choose an app and whether to connect it.')
        with self.lock:
            path = self._config_path(provider)
            original_bytes = path.read_bytes() if path.exists() else None
            settings = json.loads(original_bytes) if original_bytes is not None else {}
            self.app.DATA.mkdir(parents=True, exist_ok=True)
            if not isinstance(settings, dict) or not isinstance(settings.get('hooks', {}), dict):
                raise ValueError('Existing app hook settings could not be read. They have been preserved.')
            hooks = settings.setdefault('hooks', {})
            for event in EVENTS + (('Notification',) if provider == 'claude' else ()):
                groups = hooks.get(event, [])
                if not isinstance(groups, list):
                    raise ValueError('Existing app hook settings could not be read. They have been preserved.')
                kept = []
                for group in groups:
                    if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
                        raise ValueError('Existing app hook settings could not be read. They have been preserved.')
                    group = copy.deepcopy(group)
                    group['hooks'] = [h for h in group.get('hooks', []) if not self._ours(h, provider)]
                    if group['hooks']:
                        kept.append(group)
                if enabled:
                    handler = {'type': 'command', 'command': self._command(provider), 'timeout': 130 if event == 'PermissionRequest' else 3}
                    kept.append({'hooks': [handler]})
                if kept:
                    hooks[event] = kept
                else:
                    hooks.pop(event, None)
            if enabled:
                self._write_curl(provider)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Retain one exact backup; never overwrite other providers' hooks/settings.
            backup = self.app.DATA / f'desktop-{provider}-settings.backup.json'
            if path.exists() and not backup.exists():
                backup.write_bytes(original_bytes)
                backup.chmod(0o600)
            temporary = path.with_name(path.name + '.relay.tmp')
            temporary.write_text(json.dumps(settings, indent=2) + '\n')
            temporary.chmod(0o600)
            if (path.read_bytes() if path.exists() else None) != original_bytes:
                temporary.unlink(missing_ok=True)
                raise ValueError('App settings changed while connecting. Try again.')
            temporary.replace(path)
            if not enabled:
                for key, pending in list(self.pending.items()):
                    if pending['provider'] == provider:
                        pending['event'].set()
            return {'ok': True, 'requires_review': enabled and provider == 'codex'}

    def _usage(self, provider, windows, observed):
        if not windows or not observed or observed > self.clock() + 60:
            return
        with self.app.limits.lock:
            existing = self.app.limits._load().get(provider) or {}
            if existing.get('seen_at', 0) >= observed:
                return
            self.app.limits.data[provider] = {**windows, 'seen_at': int(observed), 'source': 'claude-desktop-history' if provider == 'claude' else 'codex-session'}
            self.app.limits._save()

    def _codex_rows(self):
        roots = list((self.home / '.codex').glob('state_*.sqlite'))
        if not roots:
            return []
        database = max(roots, key=lambda p: int(p.stem.split('_')[-1]))
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=.2)
        connection.row_factory = sqlite3.Row
        try:
            columns = {r[1] for r in connection.execute('pragma table_info(threads)')}
            fields = ['id', 'title', 'cwd', 'rollout_path', 'updated_at', 'source']
            if not set(fields).issubset(columns):
                return []
            optional = [key for key in ('originator', 'thread_source', 'model', 'name') if key in columns]
            rows = connection.execute('select ' + ','.join(fields + optional) + ' from threads where archived=0 order by updated_at desc limit 40').fetchall()
        finally:
            connection.close()
        result = []
        for raw in rows:
            data = dict(raw)
            if data.get('source') != 'vscode' or data.get('thread_source') in ('guardian_review', 'subagent'):
                continue
            originator = data.get('originator') or ''
            if originator and 'desktop' not in originator.lower():
                continue
            row = {'id': 'codex:' + data['id'], 'provider_id': data['id'], 'provider': 'codex', 'title': str(data.get('name') or data['title'])[:180],
                   'project': data['cwd'], 'model': data.get('model'), 'updated': stamp(data['updated_at']),
                   'status': 'unknown', 'activity': 'Open Codex to see this session.', 'source': 'desktop', 'requests': []}
            path = Path(data['rollout_path'])
            # Database paths are provider-owned, but never follow them outside its session directories.
            allowed = [self.home / '.codex/sessions', self.home / '.codex/archived_sessions']
            if any(path.resolve().is_relative_to(base.resolve()) for base in allowed):
                try:
                    for event in tail(path):
                        payload = event.get('payload') or {}
                        kind = payload.get('type')
                        if event.get('type') == 'event_msg':
                            if kind == 'token_count' and payload.get('rate_limits'):
                                self._usage('codex', codex_reading(payload['rate_limits']), stamp(event.get('timestamp')))
                            if kind == 'task_started':
                                row.update(status='working', activity='Working in Codex')
                            elif kind == 'task_complete':
                                row.update(status='finished', activity='Turn finished')
                            elif kind in ('turn_aborted', 'task_aborted'):
                                row.update(status='idle', activity='Turn interrupted')
                        elif event.get('type') == 'response_item' and row['status'] != 'finished':
                            if kind in ('function_call', 'custom_tool_call'):
                                if self.clock() - stamp(event.get('timestamp')) < 90:
                                    row['status'] = 'working'
                                row['activity'] = 'Using ' + str(payload.get('name') or 'a tool')[:80]
                            elif kind == 'reasoning':
                                if self.clock() - stamp(event.get('timestamp')) < 90:
                                    row['status'] = 'working'
                                row['activity'] = 'Thinking'
                    if row['status'] == 'working' and self.clock() - row['updated'] > 600:
                        row.update(status='unknown', activity='No recent activity signal')
                except (OSError, ValueError, TypeError):
                    pass
            result.append(row)
        return result[:12]

    def _claude_rows(self):
        directory = self.home / 'Library/Application Support/Claude/claude-code-sessions'
        files = sorted(list(directory.glob('*/*.json')) + list(directory.glob('*/*/*.json')), key=lambda p: p.stat().st_mtime, reverse=True)[:20] if directory.exists() else []
        result = []
        for path in files:
            try:
                data = read_json(path)
                if data.get('isArchived') or not data.get('cliSessionId'):
                    continue
                provider_id = str(data['cliSessionId'])
                if '/' in provider_id or '..' in provider_id:
                    continue
                updated = stamp(data.get('lastActivityAt') or data.get('createdAt'))
                row = {'id': 'claude:' + provider_id, 'provider_id': provider_id, 'provider': 'claude',
                       'title': str(data.get('title') or 'Claude Code session')[:180], 'project': str(data.get('originCwd') or data.get('cwd') or ''),
                       'model': data.get('model'), 'updated': updated, 'status': 'unknown',
                       'activity': 'Open Claude Code to see this session.', 'source': 'desktop', 'requests': []}
                if data.get('interruptedAwaitingPerson'):
                    row.update(status='needs_attention', activity='Needs your attention in Claude Code')
                elif stamp(data.get('lastTurnEdgeAt')) >= stamp(data.get('latestUserFrameAt')) > 0:
                    row.update(status='finished', activity='Turn finished')
                # Match the desktop's explicit CLI session id; never import unrelated CLI chats.
                transcripts = list((self.home / '.claude/projects').glob('*/' + provider_id + '.jsonl'))
                if transcripts:
                    for event in tail(transcripts[0]):
                        kind = event.get('type')
                        if kind == 'user':
                            if not event.get('toolUseResult'):
                                row.update(status='working', activity='Working in Claude Code')
                        elif kind == 'assistant':
                            message = event.get('message') or {}
                            if message.get('stop_reason') == 'end_turn':
                                row.update(status='finished', activity='Turn finished')
                            for block in message.get('content', []) if isinstance(message.get('content'), list) else []:
                                if block.get('type') == 'tool_use':
                                    row['activity'] = 'Using ' + str(block.get('name') or 'a tool')[:80]
                        elif kind == 'system' and event.get('subtype') == 'turn_duration':
                            row.update(status='finished', activity='Turn finished')
                if row['status'] == 'working' and self.clock() - updated > 600:
                    row.update(status='unknown', activity='No recent activity signal')
                result.append(row)
            except (OSError, ValueError, TypeError, AttributeError):
                continue
        return result[:12]

    def scan(self):
        rows = []
        try:
            for provider, reader in [('codex', self._codex_rows), ('claude', self._claude_rows)]:
                try:
                    rows.extend(reader())
                    if provider == 'claude':
                        usage = read_claude_usage(home=self.home)
                        if usage:
                            self._usage('claude', *usage)
                    self.problems.pop(provider, None)
                except (OSError, ValueError, sqlite3.Error):
                    self.problems[provider] = 'App activity is temporarily unavailable.'
            with self.lock:
                self.rows = {row['id']: row for row in rows}
        finally:
            with self.lock:
                self.scanning = False
                self.next_scan = self.clock() + 3

    def snapshot(self):
        with self.lock:
            if not self.scanning and self.clock() >= self.next_scan:
                self.scanning = True
                threading.Thread(target=self.scan, daemon=True, name='desktop-observer').start()
            rows = copy.deepcopy(self.rows)
            for key, row in self.hook_rows.items():
                if key in rows and (row['requests'] or row['updated'] >= rows[key]['updated']):
                    rows[key].update({field: row[field] for field in ('status', 'activity', 'requests', 'updated')})
                elif key not in rows and self.clock() - row['updated'] <= RECENT_ACTIVITY_SECONDS:
                    rows[key] = copy.deepcopy(row)
            for row in rows.values():
                if row['source'] == 'hook' and row['status'] == 'working' and self.clock() - row['updated'] > 600:
                    row.update(status='unknown', activity='No recent activity signal')
            cutoff = self.clock() - RECENT_ACTIVITY_SECONDS
            recent = [row for row in rows.values() if row.get('updated', 0) >= cutoff]
            return {'sessions': sorted(recent, key=lambda row: row['updated'], reverse=True)[:24],
                    'connections': {provider: {'installed': self.installed(provider), 'last_event': self.last_hook.get(provider),
                                               'problem': self.problems.get(provider, '')} for provider in LABELS},
                    'attention': len(self.pending)}

    def receive(self, provider, token, payload, timeout=120):
        if provider not in LABELS or not token or not hmac.compare_digest(token, self.token):
            raise ValueError('Invalid desktop connection.')
        event = payload.get('hook_event_name')
        session_id = payload.get('session_id')
        if event not in EVENTS + (('Notification',) if provider == 'claude' else ()) or not isinstance(session_id, str) or not 0 < len(session_id) <= 160:
            raise ValueError('Invalid desktop activity event.')
        key = provider + ':' + session_id
        with self.lock:
            now = self.clock()
            self.last_hook[provider] = now
            if len(self.hook_rows) >= 96 and key not in self.hook_rows:
                oldest = next((k for k, r in sorted(self.hook_rows.items(), key=lambda item: item[1]['updated']) if not r['requests']), None)
                if oldest:
                    self.hook_rows.pop(oldest)
            original = self.rows.get(key, {})
            row = self.hook_rows.setdefault(key, {'id': key, 'provider_id': session_id, 'provider': provider,
                'title': original.get('title') or LABELS[provider] + ' session', 'project': str(payload.get('cwd') or '')[:2000],
                'updated': now, 'status': 'idle', 'activity': '', 'source': 'hook', 'requests': []})
            row['updated'] = now
            if event == 'PermissionRequest':
                request_id = secrets.token_hex(12)
                inputs = payload.get('tool_input') or {}
                if not isinstance(inputs, dict):
                    inputs = {}
                # Keep only the approval context. Do not persist prompts/transcripts or full tool payloads.
                preview = {k: inputs[k] for k in ('command', 'file_path', 'path', 'url', 'host', 'description') if k in inputs}
                request = {'id': request_id, 'tool': str(payload.get('tool_name') or 'Tool')[:100], 'details': preview,
                           'created': now, 'expires_at': now + timeout, 'tool_use_id': payload.get('tool_use_id')}
                pending = {'provider': provider, 'session': key, 'event': threading.Event(), 'result': {}, 'expires_at': now + timeout}
                self.pending[request_id] = pending
                row['requests'].append(request)
                row.update(status='needs_approval', activity='Waiting for your approval')
            else:
                if event in ('PostToolUse', 'Stop', 'SessionEnd', 'UserPromptSubmit'):
                    for request in list(row['requests']):
                        if event == 'PostToolUse' and (not request.get('tool_use_id') or request['tool_use_id'] != payload.get('tool_use_id')):
                            continue
                        pending = self.pending.get(request['id'])
                        if pending:
                            pending['event'].set()
                    row['requests'] = [r for r in row['requests'] if r['id'] in self.pending and not self.pending[r['id']]['event'].is_set()]
                if event in ('UserPromptSubmit', 'PreToolUse', 'PostToolUse'):
                    row.update(status='working', activity=('Using ' + str(payload.get('tool_name'))[:80]) if payload.get('tool_name') else 'Working in ' + LABELS[provider])
                elif event == 'Stop':
                    row.update(status='finished', activity='Turn finished')
                elif event == 'Notification':
                    if payload.get('notification_type') == 'permission_prompt':
                        row.update(status='needs_attention', activity='Needs your attention in Claude Code')
                elif event == 'SessionEnd':
                    row.update(status='idle', activity='Session ended')
                else:
                    row.update(status='idle', activity='Session connected')
                if row['requests']:
                    row.update(status='needs_approval', activity='Waiting for your approval')
                return {}
        pending['event'].wait(timeout)
        with self.lock:
            self.pending.pop(request_id, None)
            row['requests'] = [r for r in row['requests'] if r['id'] != request_id]
            if not row['requests'] and row['status'] == 'needs_approval':
                row.update(status='needs_attention', activity='Continue in the original app')
            return pending['result']

    def decide(self, request_id, decision):
        if decision not in ('approve', 'reject', 'app'):
            raise ValueError('Choose Approve once, Reject, or Answer in app.')
        with self.lock:
            pending = self.pending.get(request_id)
            if not pending or pending['event'].is_set() or self.clock() >= pending['expires_at']:
                raise ValueError('This approval is no longer waiting. Check the original app.')
            if decision != 'app':
                pending['result'] = {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {
                    'behavior': 'allow' if decision == 'approve' else 'deny',
                    **({'message': 'Rejected by the user in Relay.'} if decision == 'reject' else {})}}}
            pending['event'].set()
            return {'ok': True}

    def shutdown(self):
        with self.lock:
            for pending in self.pending.values():
                pending['event'].set()
