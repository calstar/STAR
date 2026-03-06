-- test_query.lua
local client = connect("127.0.0.1:2240")
if not client then
    print("Failed to connect to Elodin DB")
    return
end

print("Connected to Elodin DB")

-- Try to find available tables/VTables
-- The Elodin Lua API is not well documented but let's try some likely methods
print("Attempting to list VTables...")
-- if client.list_vtables then
--    local vts = client:list_vtables()
--    for i, vt in ipairs(vts) do
--        print("VTable: " .. tostring(vt))
--    end
-- end

-- Try a query
local q = {
    packet_id = {0x20, 0x01},
    limit = 10
}
print("Executing query for [0x20, 0x01]...")
-- In some versions it might be client:query(q)
-- Let's try to just print the client object to see available fields
for k, v in pairs(getmetatable(client) or {}) do
    print("Method: " .. tostring(k))
end
