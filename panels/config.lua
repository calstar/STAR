-- ═══════════════════════════════════════════════════════════════════════════
-- Sensor System — Elodin DB Config
-- Sets the editor schematic to our KDL panel layout.
-- Usage:  elodin-db run [::]:2240 <db_path> --config panels/config.lua
-- ═══════════════════════════════════════════════════════════════════════════

-- The shell startup script sets SENSOR_KDL_PATH to the absolute KDL file.
local kdl = os.getenv("SENSOR_KDL_PATH")
if not kdl then
    print("[config.lua] SENSOR_KDL_PATH not set, skipping schematic config")
    return
end

-- SetDbConfig was removed in elodin-db ≥0.14. Guard so the DB still starts.
if type(SetDbConfig) ~= "function" then
    print("[config.lua] SetDbConfig not available in this elodin-db version, skipping schematic config")
    return
end

-- Connect to the local DB (same process when launched with --config).
local client = connect("[::1]:2240")

-- Tell the editor to load our schematic.
client:send_msg(SetDbConfig({
    metadata = {
        ["schematic.path"] = kdl,
    },
}))

print("[config.lua] schematic path set to: " .. kdl)
