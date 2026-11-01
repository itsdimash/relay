"""Composition root: one explicit owner for state and bound service dependencies."""
from pathlib import Path
import secrets
import threading

from . import attachments, deliver, git_ops, history, lifecycle, limits, notes, notify, providers, recovery, registry, reports, retention, translate
from . import contracts, task_queue, desktop
from .http import Handler
from .updater import Updater, RESTART_STATUS
from .workflow import Run


class Application:
    """Services share this context; separate instances never share mutable task state.

    Pure helpers remain static functions. Stateful services take this instance as
    their first argument. Run/Handler subclasses bind it without singleton imports.
    Constructing an application performs no filesystem, network, or provider I/O.
    """

    def __init__(self, root, data=None):
        self.ROOT = Path(root).resolve()
        self.DATA = Path(data) if data is not None else self.ROOT / 'data'
        self.TOKEN = secrets.token_urlsafe(32)
        self.LOCK = threading.RLock()
        self.RUNS = {}
        self.ACTIVE = None
        self.SHUTTING_DOWN = threading.Event()
        self.updater = Updater()
        # How much of each tool's usage limits is left; reads nothing until the first screen asks.
        self.limits = limits.Limits(self.DATA / 'limits.json', providers.executable, read_codex=lambda _: None, read_claude=limits.read_claude_usage_status,
                                    reader_sources={'claude': 'claude-usage-command'})
        self.limits.delays['claude'] = (60, 120)
        # Puts finished downloads on the Deliver shelf when that is switched on; looks at nothing until watching starts.
        self.catcher = deliver.Catcher(self)
        self.desktop = desktop.DesktopCompanion(self)

        class TaskRun(Run):
            app = self

        class RequestHandler(Handler):
            app = self

        self.Run = TaskRun
        self.Handler = RequestHandler

    @staticmethod
    def quit_for_update():
        """Exit shortly after the HTTP response is sent; the native app sees RESTART_STATUS and quits too."""
        import os
        threading.Timer(0.8, lambda: os._exit(RESTART_STATUS)).start()

    DEFAULT_TEAM = contracts.DEFAULT_TEAM
    IMAGE_TYPES = contracts.IMAGE_TYPES
    MAX_IMAGE_BYTES = contracts.MAX_IMAGE_BYTES
    PROVIDERS = contracts.PROVIDERS
    ROLES = contracts.ROLES
    SCHEMA = contracts.SCHEMA
    Stopped = contracts.Stopped
    TASK_MODES = contracts.TASK_MODES
    TERMINAL = contracts.TERMINAL

    # Report validation, summaries, follow-up context, and timestamps.
    now = staticmethod(reports.now)
    source_findings = staticmethod(reports.source_findings)
    report_context = staticmethod(reports.report_context)
    plan_from_conversation = staticmethod(reports.plan_from_conversation)
    reported_checks = staticmethod(reports.reported_checks)
    report_metadata = staticmethod(reports.report_metadata)
    validate_questions = staticmethod(reports.validate_questions)
    validate_review = staticmethod(reports.validate_review)

    # Git inspection and complete patch export; never stage into the real index.
    git = staticmethod(git_ops.git)
    capture_file_reviews = staticmethod(git_ops.capture_file_reviews)
    complete_patch = staticmethod(git_ops.complete_patch)
    create_baseline = staticmethod(git_ops.create_baseline)
    git_common_directory = staticmethod(git_ops.git_common_directory)

    # Provider discovery, capability-limited commands, and response adapters.
    executable = staticmethod(providers.executable)
    model_catalog = staticmethod(providers.model_catalog)
    validate_team = staticmethod(providers.validate_team)
    provider_command = staticmethod(providers.provider_command)
    tool_status = staticmethod(providers.tool_status)

    # Saved projects, team presets, and folder browsing.
    team_presets = registry.team_presets
    save_team_preset = registry.save_team_preset
    read_projects = registry.read_projects
    project_choices = registry.project_choices
    save_project = registry.save_project
    write_projects = registry.write_projects
    remove_project = registry.remove_project
    folder_choices = staticmethod(registry.folder_choices)

    # System notification for tasks that run while the person is away.
    notify = staticmethod(notify.send)

    # Quick notes and to-dos shown in the notch panel.
    read_notes = notes.read_notes
    write_notes = notes.write_notes
    add_note = notes.add_note
    set_note_done = notes.set_done
    remove_note = notes.remove_note
    due_reminders = notes.due_reminders
    mark_reminded = notes.mark_reminded
    snooze_note = notes.snooze

    # The notch's Translate page: Gemini translates, and the engine keeps the API key.
    translate_status = translate.status
    translate_text = translate.translate
    set_translate_key = translate.save_key

    queue_snapshot = task_queue.queue_snapshot
    add_queued_task = task_queue.add_task
    remove_queued_task = task_queue.remove_task
    move_queued_task = task_queue.move_task
    start_queued_task = task_queue.start_task

    # Files waiting on the notch panel's Deliver shelf (paths only).
    read_deliver_items = deliver.read_items
    write_deliver_items = deliver.write_items
    deliver_list = deliver.listing
    add_deliver = deliver.add_paths
    remove_deliver = deliver.remove_item
    clear_deliver = deliver.clear_items
    deliver_settings = deliver.read_settings
    set_deliver_settings = deliver.set_settings
    zip_deliver = deliver.make_zip
    expire_deliver = deliver.expire_items
    watch_downloads = deliver.watch_downloads

    # Image validation and task-scoped attachment access.
    decode_images = staticmethod(attachments.decode_images)
    saved_image_path = attachments.saved_image_path
    inherited_images = attachments.inherited_images

    # Saved conversation loading, snapshots, and permanent deletion.
    report_source = history.report_source
    load_runs = history.load_runs
    history_path = history.history_path
    delete_history = history.delete_history
    states = history.states
    run_info = history.run_info
    write_state = staticmethod(history.write_state)
    count_events = staticmethod(history.count_events)

    # Optional limits on how much history is kept.
    storage_usage = retention.usage
    retention_policy = retention.read_policy
    set_retention_policy = retention.set_policy
    enforce_retention = retention.enforce

    # Checkpoint admission and preserved-workspace validation.
    require_recovery_approval = staticmethod(recovery.require_recovery_approval)
    recovery_option = staticmethod(recovery.recovery_option)
    validate_recovery_workspace = recovery.validate_recovery_workspace
    recover_run = recovery.recover_run

    # Server startup, development metadata, instance locking, and shutdown.
    dev_metadata = lifecycle.dev_metadata
    acquire_instance_lock = lifecycle.acquire_instance_lock
    main = lifecycle.main
