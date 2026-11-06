#include <cstdio>
#include <cstring>
#include <cassert>
#include "DAQv2-Comms.h"
extern "C" {
#include "diablo_proto.h"
}
using namespace Diablo;
static int fails = 0;
static void cmp(const char* name, const uint8_t* a, size_t na, const uint8_t* b, size_t nb) {
  bool ok = na == nb && na > 0 && memcmp(a, b, na) == 0;
  printf("%-28s club=%3zu ours=%3zu  %s\n", name, na, nb, ok ? "MATCH" : "DIFF");
  if (!ok) fails++;
}
int main() {
  uint8_t A[512], B[512];
  // heartbeat
  BoardHeartbeatPacket hb; for (int i=0;i<32;i++) hb.firmware_hash[i]=i*7+1;
  hb.board_id = 99; hb.engine_state = EngineState::LOX_FILL; hb.board_state = BoardState::ACTIVE;
  size_t na = create_board_heartbeat_packet(hb, 123456, A, sizeof A);
  size_t nb = diablo_build_board_heartbeat(B, sizeof B, 123456, hb.firmware_hash, 99, 2, 2);
  cmp("board heartbeat", A, na, B, nb);

  // sensor data: 9 chunks x 3 sensors incl. negative value
  std::vector<SensorDataChunkCollection> cc; diablo_chunk_t ch[9];
  uint8_t ids[3] = {1,3,4};
  for (int c=0;c<9;c++) {
    cc.emplace_back(1000+c*40, 3); ch[c].timestamp_ms = 1000+c*40;
    for (int s=0;s<3;s++) { uint32_t v = (uint32_t)(int32_t)(c*1000003 - 2000000 + s*17);
      cc.back().add_datapoint(ids[s], v); ch[c].points[s].sensor_id = ids[s]; ch[c].points[s].data = v; }
  }
  na = create_sensor_data_packet(cc, 3, 777, A, sizeof A);
  nb = diablo_build_sensor_data(B, sizeof B, 777, ch, 9, 3);
  cmp("sensor data 9x3", A, na, B, nb);

  // self test
  std::vector<SelfTestResult> r = {{1,1},{2,0},{7,0}};
  diablo_self_test_result_t r2[3] = {{1,1},{2,0},{7,0}};
  na = create_self_test_packet(1, r, 55, A, sizeof A);
  nb = diablo_build_self_test(B, sizeof B, 55, 1, r2, 3);
  cmp("self test", A, na, B, nb);

  // parse sensor config built by club (with and without abort controller)
  for (int ab=0; ab<2; ab++) {
    std::vector<uint8_t> sid = {4,1,2,9};
    uint8_t ipb[4] = {192,168,2,11}; uint32_t ip; memcpy(&ip, ipb, 4);
    na = create_sensor_config_packet(sid, 1, ab, ip, 0, 42, A, sizeof A);
    diablo_sensor_config_t cfg;
    bool ok = diablo_parse_sensor_config(A, na, &cfg);
    ok = ok && cfg.num_sensors==4 && cfg.sensor_ids[0]==4 && cfg.sensor_ids[3]==9 && cfg.reference_voltage==1
         && cfg.necessary_for_abort==(bool)ab && cfg.enable_serial_printing==0
         && (ab ? memcmp(cfg.controller_ip, ipb, 4)==0 : cfg.controller_ip[0]==0);
    // truncated packet must be rejected
    ok = ok && !diablo_parse_sensor_config(A, na-1, &cfg);
    printf("%-28s %s\n", ab ? "parse config (abort+ip)" : "parse config (no abort)", ok ? "OK" : "FAIL");
    if (!ok) fails++;
  }
  // server heartbeat: hand-built like the server would
  uint8_t sh[7] = {2,0, 1,0,0,0, 3}; uint8_t es=0;
  bool ok = diablo_parse_server_heartbeat(sh, 7, &es) && es==3 && !diablo_parse_server_heartbeat(sh,6,&es);
  printf("%-28s %s\n", "parse server heartbeat", ok ? "OK":"FAIL"); if(!ok) fails++;
  printf(fails ? "\n%d FAILED\n" : "\nALL PASS\n", fails);
  // dump our sensor packet for the python check
  nb = diablo_build_sensor_data(B,sizeof B,777,ch,9,3);
  FILE* f=fopen("sd.bin","wb"); fwrite(B,1,nb,f); fclose(f);
  nb = diablo_build_board_heartbeat(B,sizeof B,123456,hb.firmware_hash,99,2,2);
  f=fopen("hb.bin","wb"); fwrite(B,1,nb,f); fclose(f);
  return fails;
}
