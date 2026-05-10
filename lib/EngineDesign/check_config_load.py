import yaml
from engine.pipeline.config_schemas import PintleEngineConfig

def test_config_load():
    config_path = "/Users/carlton/Downloads/Layer 3 Optimized Config.yaml"
    with open(config_path, 'r') as f:
        data = yaml.safe_load(f)
    
    # This should succeed if the schema update is correct
    try:
        config = PintleEngineConfig(**data)
        reqs = config.design_requirements
        print("Successfully loaded config!")
        print(f"max_pintle_tip_diameter: {reqs.max_pintle_tip_diameter}")
        
        if reqs.max_pintle_tip_diameter == 0.040:
            print("VERIFICATION SUCCESS: Value matches expected 40mm.")
        else:
            print(f"VERIFICATION FAILED: Value is {reqs.max_pintle_tip_diameter}, expected 0.040")
            
    except Exception as e:
        print(f"VERIFICATION FAILED: {e}")

if __name__ == "__main__":
    test_config_load()
