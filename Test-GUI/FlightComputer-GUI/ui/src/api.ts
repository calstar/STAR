// How the window reaches the backend. In the app that is Tauri IPC; in the
// browser tests it is a WebSocket to the test harness (examples/serve.rs),
// which runs the same backend. Same calls, same events, either way.

import type { Batch, Command, FlightPlot, Pick, View } from "./types";

export interface Listener {
  view(v: View): void;
  live(b: Batch): void;
}

export interface Api {
  send(c: Command): Promise<void>;
  view(): Promise<View | null>;
  flightPlot(): Promise<FlightPlot | null>;
  pick(what: Pick): Promise<void>;
  listen(l: Listener): Promise<void>;
}

async function tauri(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    send: (command) => invoke("send", { command }),
    view: () => invoke("view"),
    flightPlot: () => invoke("flight_plot"),
    pick: (what) => invoke("pick", { what }),
    listen: async (l) => {
      await listen<View>("view", (e) => l.view(e.payload));
      await listen<Batch>("live", (e) => l.live(e.payload));
    },
  };
}

function websocket(url: string): Api {
  const ws = new WebSocket(url);
  const opened = new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error(`cannot reach the test backend at ${url}`));
  });
  let next = 1;
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let listener: Listener | null = null;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.event === "view") listener?.view(msg.payload);
    else if (msg.event === "live") listener?.live(msg.payload);
    else if (typeof msg.id === "number") {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.err !== undefined) w?.fail(new Error(msg.err));
      else w?.ok(msg.ok);
    }
  };
  const call = async <T>(method: string, args: object = {}): Promise<T> => {
    await opened;
    const id = next++;
    return new Promise<T>((ok, fail) => {
      waiting.set(id, { ok: ok as (v: unknown) => void, fail });
      ws.send(JSON.stringify({ id, method, args }));
    });
  };
  return {
    send: (command) => call("send", { command }),
    view: () => call("view"),
    flightPlot: () => call("flight_plot"),
    pick: (what) => call("pick", { what }),
    listen: async (l) => {
      listener = l;
      await opened;
    },
  };
}

export async function connect(): Promise<Api> {
  if ("__TAURI_INTERNALS__" in window) return tauri();
  const port = new URLSearchParams(location.search).get("ws");
  if (port) return websocket(`ws://${location.hostname}:${port}`);
  throw new Error("This page is the flight computer app's window. Run it with `npm run tauri dev`, not in a browser.");
}
