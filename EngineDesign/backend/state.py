"""In-memory application state for config and runner."""

import threading
from typing import Optional, Tuple
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner


class AppState:
    """Holds the current config and runner instance.

    The two are one pair: the runner is built from the config. Solves run in the thread pool
    (``backend.session.run_compute``) while the config endpoints replace the pair, so a solve
    takes ``snapshot()`` once and uses only that, and ``set_config`` swaps both at once.
    """

    def __init__(self):
        self.config: Optional[PintleEngineConfig] = None
        self.runner: Optional[PintleEngineRunner] = None
        self.config_path: Optional[str] = None
        self._pair_lock = threading.Lock()

    def set_config(self, config: PintleEngineConfig, config_path: Optional[str] = None) -> None:
        """Set config and create a new runner instance.

        The runner is built first -- seconds, for a propellant whose CEA cache has to load --
        and the pair swapped together after, so nothing reads the new config beside the old
        runner while it builds. A runner that fails to build leaves the old pair in place.
        """
        runner = PintleEngineRunner(config)
        with self._pair_lock:
            self.config = config
            self.runner = runner
            if config_path is not None:
                self.config_path = config_path

    def snapshot(self) -> Tuple[Optional[PintleEngineConfig], Optional[PintleEngineRunner]]:
        """The config and the runner built from it, read together.

        A solve takes this once. Reading ``self.config`` again after the solve would pick up a
        config written while it ran, and report one design's numbers against another's.
        """
        with self._pair_lock:
            return self.config, self.runner

    def has_config(self) -> bool:
        """Check if a config is loaded."""
        return self.config is not None and self.runner is not None


# There is intentionally no module-level singleton. Live state is per-user:
# each request resolves its own AppState via backend.session.get_session, so two
# users connected at once never share one config/runner. See backend/session.py.
