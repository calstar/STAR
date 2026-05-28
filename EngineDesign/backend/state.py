"""In-memory application state for config and runner."""

from typing import Optional
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner


class AppState:
    """Holds the current config and runner instance."""
    
    def __init__(self):
        self.config: Optional[PintleEngineConfig] = None
        self.runner: Optional[PintleEngineRunner] = None
        self.config_path: Optional[str] = None
    
    def set_config(
        self,
        config: PintleEngineConfig,
        config_path: Optional[str] = None,
        defer_runner: bool = False,
    ) -> None:
        """Set config and optionally create the runner immediately.

        When ``defer_runner`` is True, only the config is stored; call
        :meth:`ensure_runner` before any code path that needs ``PintleEngineRunner``
        (CEA cache build can take a long time and must not block FastAPI startup).
        """
        self.config = config
        if config_path is not None:
            self.config_path = config_path
        if defer_runner:
            self.runner = None
        else:
            self.runner = PintleEngineRunner(config)

    def ensure_runner(self) -> PintleEngineRunner:
        """Build the runner on first use if it was deferred or cleared."""
        if self.config is None:
            raise RuntimeError("No config loaded; cannot create runner")
        if self.runner is None:
            self.runner = PintleEngineRunner(self.config)
        return self.runner

    def has_config(self) -> bool:
        """True once a validated config object is loaded (runner may still be building)."""
        return self.config is not None


# Global singleton instance
app_state = AppState()

