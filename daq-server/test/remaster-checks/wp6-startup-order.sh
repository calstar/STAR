#!/bin/bash
# WP6 G11 (DESIGN-WP6 §6.3, startup-order check): every top-level startup statement of
# src/server.ts, top to bottom, diffed against the hand-written target list of §1.2's last
# column. Run at the end of step 1 and of step 2. An order difference is a stop; a spelling the
# list did not anticipate is fixed in the list and reported.
#
#   bash test/remaster-checks/wp6-startup-order.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$HERE/../.." && pwd -P)/diablo_server/backend/src"
actual() {
  grep -E "^(setInterval\(|elodin\.on\('|wss\.on\('|(init|load|reload|start)[A-Za-z]*\(|attachWebSocketServer\(|video\.start\(|httpServer\.(on|listen)\(|process\.on\()" "$SRC/server.ts" \
    | sed -E 's/ *\{.*$//'
}
target() { cat <<'LIST'
setInterval(pruneHistory, 60_000);
initGuiStream();
setInterval(flushClientOutboxes, 100);
setInterval(resetOutboxStats, 10_000);
setInterval(flushEnvelopes, 50);
initMissionTime();
initCalibrationState();
initConfigCaches();
loadBoardsFromConfig();
reloadStateActuatorMap();
setInterval(logDiagnostics, 5000);
setInterval(markStaleBoards, 1000);
initStats();
initEngineState();
video.start();
attachWebSocketServer(httpServer);
startDhcpStatusPoller();
setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ);
setInterval(reapUnresponsiveClients, KEEPALIVE_MS);
wss.on('connection', handleConnection);
setInterval(broadcastConnectionStatus, 1000);
elodin.on('connected', onElodinConnected);
setInterval(refreshScriptStatus, 15000);
elodin.on('dbError', onElodinDbError);
elodin.on('disconnected', onElodinDisconnected);
elodin.on('error', onElodinError);
elodin.on('packet', handleElodinPacket);
process.on('uncaughtException', (err) =>
process.on('unhandledRejection', (reason) =>
httpServer.on('error', (err: NodeJS.ErrnoException) =>
startGuiStaticServer(GUI_PORT);
httpServer.listen(WS_PORT, () =>
LIST
}
diff <(target) <(actual) && echo "startup order: $(actual | wc -l | tr -d ' ') statements, as §1.2"
