#!/usr/bin/env python3
"""
Performance Monitor for Multi-Threaded Calibration System

Tracks:
- Thread CPU usage
- Consensus computation time
- Calibration update time
- Memory usage
- Queue depths

Usage:
    python calibration_performance_monitor.py
"""

import time
import threading
import psutil
import logging
from dataclasses import dataclass
from typing import Dict, List

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class PerformanceMetrics:
    timestamp: float
    main_thread_cpu: float
    consensus_thread_cpu: float
    calibration_thread_cpu: float
    total_memory_mb: float
    consensus_time_ms: float
    calibration_time_ms: float
    consensus_queue_depth: int
    calibration_queue_depth: int


class PerformanceMonitor:
    def __init__(self):
        self.metrics_history: List[PerformanceMetrics] = []
        self.consensus_times: List[float] = []
        self.calibration_times: List[float] = []
        self._running = False
        self._thread = None

        # Process handle for CPU monitoring
        self.process = psutil.Process()

    def start(self):
        """Start monitoring in background thread"""
        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()
        logger.info("Performance monitor started")

    def stop(self):
        """Stop monitoring"""
        self._running = False
        if self._thread:
            self._thread.join(timeout=1.0)
        logger.info("Performance monitor stopped")

    def record_consensus_time(self, time_ms: float):
        """Record time taken for consensus computation"""
        self.consensus_times.append(time_ms)
        if len(self.consensus_times) > 100:
            self.consensus_times = self.consensus_times[-100:]

    def record_calibration_time(self, time_ms: float):
        """Record time taken for calibration update"""
        self.calibration_times.append(time_ms)
        if len(self.calibration_times) > 100:
            self.calibration_times = self.calibration_times[-100:]

    def _monitor_loop(self):
        """Background monitoring loop"""
        while self._running:
            try:
                # Get per-thread CPU usage
                threads = self.process.threads()

                # Memory usage
                memory_mb = self.process.memory_info().rss / 1024 / 1024

                # Average times
                avg_consensus_ms = (
                    sum(self.consensus_times) / len(self.consensus_times)
                    if self.consensus_times
                    else 0
                )
                avg_calibration_ms = (
                    sum(self.calibration_times) / len(self.calibration_times)
                    if self.calibration_times
                    else 0
                )

                # Create metrics record
                metrics = PerformanceMetrics(
                    timestamp=time.time(),
                    main_thread_cpu=0.0,  # Would need thread-specific monitoring
                    consensus_thread_cpu=0.0,
                    calibration_thread_cpu=0.0,
                    total_memory_mb=memory_mb,
                    consensus_time_ms=avg_consensus_ms,
                    calibration_time_ms=avg_calibration_ms,
                    consensus_queue_depth=0,  # Would need access to queue objects
                    calibration_queue_depth=0,
                )

                self.metrics_history.append(metrics)
                if len(self.metrics_history) > 1000:
                    self.metrics_history = self.metrics_history[-1000:]

                time.sleep(1.0)  # Monitor every second

            except Exception as e:
                logger.error(f"Performance monitoring error: {e}")

    def get_summary(self) -> Dict:
        """Get performance summary"""
        if not self.metrics_history:
            return {}

        recent = self.metrics_history[-60:]  # Last minute

        return {
            "avg_memory_mb": sum(m.total_memory_mb for m in recent) / len(recent),
            "max_memory_mb": max(m.total_memory_mb for m in recent),
            "avg_consensus_ms": sum(m.consensus_time_ms for m in recent) / len(recent),
            "max_consensus_ms": max(m.consensus_time_ms for m in recent),
            "avg_calibration_ms": sum(m.calibration_time_ms for m in recent)
            / len(recent),
            "max_calibration_ms": max(m.calibration_time_ms for m in recent),
            "samples": len(recent),
        }

    def print_summary(self):
        """Print performance summary to console"""
        summary = self.get_summary()
        if not summary:
            logger.info("No performance data yet")
            return

        logger.info("=== Performance Summary (Last 60s) ===")
        logger.info(
            f"Memory: {summary['avg_memory_mb']:.1f} MB avg, {summary['max_memory_mb']:.1f} MB max"
        )
        logger.info(
            f"Consensus: {summary['avg_consensus_ms']:.1f} ms avg, {summary['max_consensus_ms']:.1f} ms max"
        )
        logger.info(
            f"Calibration: {summary['avg_calibration_ms']:.1f} ms avg, {summary['max_calibration_ms']:.1f} ms max"
        )
        logger.info(f"Samples: {summary['samples']}")


# Example usage in channel_plotter.py:
#
# from calibration_performance_monitor import PerformanceMonitor
#
# class App(QtWidgets.QMainWindow):
#     def __init__(self):
#         ...
#         self.perf_monitor = PerformanceMonitor()
#         self.perf_monitor.start()
#
# # In ConsensusWorkerThread.run():
#     start = time.time()
#     consensus = self.global_system.compute_consensus_pressure(...)
#     elapsed_ms = (time.time() - start) * 1000
#     if hasattr(self, 'perf_monitor'):
#         self.perf_monitor.record_consensus_time(elapsed_ms)
#
# # Similar for calibration worker

if __name__ == "__main__":
    # Test the monitor
    monitor = PerformanceMonitor()
    monitor.start()

    try:
        while True:
            time.sleep(5)
            monitor.print_summary()
    except KeyboardInterrupt:
        monitor.stop()
