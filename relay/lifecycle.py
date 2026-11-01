"""Server startup, development metadata, instance locking, and shutdown."""
import argparse
import hashlib
import os
import signal
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer


def dev_metadata(app):
    if os.environ.get('RELAY_DEV') != '1':
        return None
    files = []
    for path in sorted((app.ROOT / 'static').rglob('*')):
        if path.is_file():
            try:
                stat = path.stat()
                files.append(f'{path.relative_to(app.ROOT)}:{stat.st_mtime_ns}:{stat.st_size}')
            except FileNotFoundError:
                pass
    revision = hashlib.sha256(('\n'.join(files) + app.TOKEN).encode()).hexdigest()
    busy = bool(app.ACTIVE and not app.ACTIVE.finished.is_set())
    return {'revision': revision, 'busy': busy}


def acquire_instance_lock(app):
    """Protect the shared data folder even if another instance uses a different port."""
    import fcntl
    app.DATA.mkdir(parents=True, exist_ok=True)
    handle = (app.DATA / '.instance.lock').open('a+')
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise RuntimeError('Relay is already running with this data folder. Open its existing dashboard or stop that instance first.')
    return handle


def process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_when_app_exits(app, pid, interval=2.0):
    """The macOS app starts this engine. If the app is killed or crashes, stop too, so no engine is left holding the data folder."""
    def watch():
        while not app.SHUTTING_DOWN.wait(interval):
            if not process_alive(pid):
                os.kill(os.getpid(), signal.SIGTERM)
                return
    thread = threading.Thread(target=watch, name='app-watcher', daemon=True)
    thread.start()
    return thread


def main(app):
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true', help='Open the dashboard in your default browser')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.exit(1, 'Relay currently requires macOS or a POSIX environment; Windows is not supported.\n')
    try:
        instance_lock = app.acquire_instance_lock()
    except RuntimeError as error:
        parser.exit(1, str(error) + '\n')
    try:
        app.load_runs()
        app.enforce_retention()
        server = ThreadingHTTPServer(('127.0.0.1', args.port), app.Handler)
        # Closing the server must never wait for a request thread; a stuck connection once kept the engine alive after quit.
        app.desktop.bind(f'http://127.0.0.1:{server.server_port}')
        server.daemon_threads = True
        server.block_on_close = False
    except OSError as error:
        instance_lock.close()
        parser.exit(1, f'Could not start Relay: {error}\n')
    print(f'Relay is ready at http://127.0.0.1:{server.server_port}', flush=True)
    if args.open:
        threading.Timer(.3, webbrowser.open, args=[f'http://127.0.0.1:{server.server_port}']).start()
    def handle_shutdown(signum, frame):
        # Repeated Ctrl+C/SIGTERM must not interrupt final persistence.
        if not app.SHUTTING_DOWN.is_set():
            app.SHUTTING_DOWN.set()
            raise KeyboardInterrupt
    previous_handlers = {sig: signal.signal(sig, handle_shutdown) for sig in (signal.SIGINT, signal.SIGTERM)}
    app_pid = os.environ.get('RELAY_APP_PID', '')
    if app_pid.isdigit() and int(app_pid) > 1:
        stop_when_app_exits(app, int(app_pid))
    app.watch_downloads()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with app.LOCK:
            app.SHUTTING_DOWN.set()
            active = app.ACTIVE
            if active and not active.finished.is_set():
                active.stop_event.set()
                active.resume_event.set()
        try:
            app.desktop.shutdown()
            if active and not active.finished.is_set():
                active.stop_process()
                if not active.finished.wait(60):
                    with app.LOCK:
                        active.info['status'] = 'interrupted'
                        active.info['summary'] = 'Relay shut down before cleanup finished. Changes are preserved for inspection.'
                        active.save()
                    print('Task cleanup did not finish before shutdown. Inspect the preserved working copy.', flush=True)
        finally:
            server.server_close()
            instance_lock.close()
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)
