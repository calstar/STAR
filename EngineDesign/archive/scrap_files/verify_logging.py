
import sys
import os
sys.path.append(os.getcwd())

from engine.core.runner import PintleEngineRunner
from engine.pipeline.config_schemas import PintleEngineConfig
import yaml

# Mock config
def create_mock_config():
    with open("configs/default.yaml", "r") as f:
        config_dict = yaml.safe_load(f)
    return PintleEngineConfig(**config_dict)

def test_debug_logging():
    print("Testing debug logging...")
    try:
        config = create_mock_config()
        runner = PintleEngineRunner(config)
        
        # Run with debug=True
        print("Running with debug=True...")
        runner.evaluate(4.5e6, 3.5e6, debug=True)
        
        # Check if log file exists
        log_file = "output/logs/evaluate.log"
        if os.path.exists(log_file):
            print(f"PASS: Log file created at {log_file}")
            with open(log_file, "r") as f:
                content = f.read()
                if "[SOLVER_DEBUG]" in content:
                    print("PASS: Log contains SOLVER_DEBUG")
                else:
                    print("FAIL: Log missing SOLVER_DEBUG")
        else:
            print("FAIL: Log file not created")
            
    except Exception as e:
        print(f"FAIL: Exception during execution: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_debug_logging()
