import tomli
import json
import os
import sys


def main():
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "config.toml")
    try:
        with open(config_path, "rb") as f:
            config = tomli.load(f)
    except Exception as e:
        print(f"Error loading config: {e}", file=sys.stderr)
        sys.exit(1)

    sensor_roles = config.get("sensor_roles_pt_board", config.get("sensor_roles", {}))
    boards = config.get("boards", {})

    # Map packet_id to entity name
    # packet_id is formatted as "HIGH_LOW" hex strings, e.g., "0x20_1"
    mapping = {}

    # PT defaults and board-specific roles (PT, TC, RTD, LC, etc)
    # The config has `sensor_roles_pt_board`, `sensor_roles_pt2`, etc. Find anything starting with `sensor_roles`
    for section_name, section_data in config.items():
        if section_name.startswith("sensor_roles_"):
            # Determine type from board id/name (PT is 0x20, TC=0x21, RTD=0x22, LC=0x23)
            # Default to PT
            prefix = "PT"
            hi_byte = 0x20

            if "tc" in section_name:
                prefix = "TC"
                hi_byte = 0x21
            elif "rtd" in section_name:
                prefix = "RTD"
                hi_byte = 0x22
            elif "lc" in section_name:
                prefix = "LC"
                hi_byte = 0x23

            for role_name, channel_id in section_data.items():
                if isinstance(channel_id, int):
                    entity_name = role_name.replace(" ", "_")
                    mapping[f"0x{hi_byte:02x}_{channel_id}"] = f"{prefix}.{entity_name}"
                    mapping[f"0x{hi_byte:02x}_{0x10 + channel_id}"] = (
                        f"{prefix}_Cal.{entity_name}"
                    )

    # Actuators
    actuator_roles = config.get("actuator_roles", {})
    for role_name, act_info in actuator_roles.items():
        if isinstance(act_info, list) and len(act_info) >= 2:
            channel_id = act_info[1]
            if isinstance(channel_id, int):
                entity_name = role_name.replace(" ", "_")
                mapping[f"0x30_{channel_id}"] = f"ACT.{entity_name}"

    # Fill in remainder gaps with generic names if desired, but
    # fsw_web_bridge can handle the fallback.

    # Save mapping to /tmp/sensor_map.json
    try:
        with open("/tmp/sensor_map.json", "w") as f:
            json.dump(mapping, f, indent=2)
    except Exception as e:
        print(f"Error writing mapping: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
