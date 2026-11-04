# ground/ — the ground station's side of a channel hop

The transmitter can change channel in flight (anywhere from 1243.5 to
1296.5 MHz) when the flight computer tells it to; see
`../esp32p4/README.md`, *Channels and hops*. The ground has to follow, and
it learns about the hop from the video stream itself: every 100 ms the
transmitter sends a channel table (PID 0x1FF0) saying which channel it is
on and, once a hop is accepted, where it is going and at what stream time.

`dvbt_hop.py` reads that table out of the transport stream the receiver
delivers and says when to retune:

```python
import dvbt_hop
f = dvbt_hop.Follower(tuned_khz=1279000, channels=[1279000, 1255000, 1265000])
for pkt in receiver_packets():           # 188-byte TS packets (the UT-130B SDK's TS callback)
    khz = f.feed(pkt)
    if khz:
        receiver.tune(khz)               # the HiDes SDK call that sets the frequency
on_lock_lost = lambda: f.lost_lock()     # retune if a hop was announced, else None
hunt = f.hunt_list()                     # no hop pending and no lock: try these in order
```

- Retune only on the **table**, never on the uplink's own acknowledgement:
  the table proves the transmitter accepted the hop and is going.
- It retunes **100 ms before** the announced time, by the received stream's
  clock. A receiver's output trails the air by its pipeline, and the
  packets still inside it when the signal leaves are never delivered
  (gr-dtv: the last ~45 ms), so waiting for the hop time itself would wait
  forever; `lost_lock()` covers that case too.
- Lost with nothing announced (a missed table, a fade): try `hunt_list()`
  -- the current channel first, then the pad's list.

Measured in the end-to-end test (`../test/e2e`, `hop_followed_by_the_ground`):
the transmitter is dark ~0.3 ms, the stream is lost for ~150 ms across the
hop, and the video is back with the key frame the transmitter makes 250 ms
after the hop.

**Not done:** the station program that drives the UT-130B. It needs the
HiDes SDK's calls for setting the frequency and receiving the TS -- confirm
on the bench that the SDK exposes both, and how long the UT-130B takes to
acquire after a retune (gr-dtv: ~95 ms).
