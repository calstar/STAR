"""Domain-specific exceptions for the engine solver."""


class EngineShutdownException(Exception):
    """
    Raised when a physical shutdown condition prevents the engine from sustaining
    combustion. This is NOT a convergence bug — it is an expected physical event
    that the time-series loop should handle gracefully by stopping the burn.

    Attributes
    ----------
    reason : str
        Short reason code, e.g. "supply_below_demand" or "pressure_bounds_invalid".
    details : dict
        Diagnostic payload with keys such as:
            P_tank_O_Pa   – oxidizer tank pressure at shutdown [Pa]
            P_tank_F_Pa   – fuel tank pressure at shutdown [Pa]
            Pc_max_Pa     – maximum achievable chamber pressure [Pa]
            Pc_min_Pa     – minimum valid chamber pressure [Pa]
            residual_min  – supply-demand residual at Pc_min [kg/s]  (optional)
            residual_max  – supply-demand residual at Pc_max [kg/s]  (optional)
    """

    def __init__(self, reason: str, details: dict | None = None):
        self.reason = reason
        self.details = details or {}
        super().__init__(f"Engine shutdown: {reason}. Details: {self.details}")
