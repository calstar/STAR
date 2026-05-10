
import pickle
import sys
from pathlib import Path

# Add project root to path
sys.path.append("/home/adnan/EngineDesign")

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner

def test_pickle():
    print("Creating config...")
    config = PintleEngineConfig(
        req_name="Test",
        oxidizer="LOX",
        fuel="Ethanol",
        chamber_geometry={"A_throat": 0.001, "A_exit": 0.01, "expansion_ratio": 10.0}
    )
    
    print("Creating runner...")
    runner = PintleEngineRunner(config)
    
    print("Pickling runner...")
    try:
        pickled = pickle.dumps(runner)
        print(f"Pickle size: {len(pickled)} bytes")
        
        print("Unpickling runner...")
        unpickled = pickle.loads(pickled)
        print("Success!")
    except Exception as e:
        print(f"Failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_pickle()
