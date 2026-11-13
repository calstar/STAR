// The window. It draws the backend's view and sends commands; every rule
// (what may be sent, what a reply means, every sentence shown) is in the
// backend (src/backend). The only state kept here is about the screen itself:
// which tab is open, which flight row is highlighted, whether Live is paused,
// and the text typed into the wipe dialog.

import { html, nothing, render, type TemplateResult } from "lit-html";
import { connect, type Api } from "./api";
import { FlightPlots, LivePlots } from "./plots";
import type { Command, Reading, ConfigView, FieldView, FlightsView, GroundView, HeartbeatRow, Pick, Row, StatusView, Tone, View } from "./types";
import "./style.css";
import logoBlue from "./assets/star-logo-blue.png";
import logoWhite from "./assets/star-logo-white.png";

type Tab = "status" | "live" | "config" | "flights" | "ground";
const TABS: [Tab, string][] = [
  ["status", "Status"],
  ["live", "Live"],
  ["config", "Config"],
  ["flights", "Flights"],
  ["ground", "Ground"],
];

const ui = {
  tab: "status" as Tab,
  selected: null as number | null,
  wipeOpen: false,
  wipeText: "",
  readings: [] as Reading[],
  armConfirm: false, // the Ground tab's Arm waits for a second click
};

let api: Api;
let view: View | null = null;
const live = new LivePlots(30);
// The browser tests (the ?ws= harness, never the app) read the chart data.
if (new URLSearchParams(location.search).has("ws")) (window as unknown as { live: LivePlots }).live = live;
const flight = new FlightPlots();
const root = document.getElementById("app")!;

const send = (c: Command) => void api.send(c);
const pick = (what: Pick) => void api.pick(what).catch(() => {});

function set(patch: Partial<typeof ui>) {
  Object.assign(ui, patch);
  draw();
}

// ---------------------------------------------------------------- pieces

const chip = (text: string, tone: Tone | null) => html`<span class="chip tone-${tone ?? "neutral"}">${text}</span>`;

function rows(list: Row[]) {
  return html`<dl class="rows">
    ${list.map(
      (r) => html`<dt>${r.name}</dt>
        <dd>${r.chip ? chip(r.value, r.chip) : r.value}${r.hint ? html`<span class="help" data-tip=${r.hint}>?</span>` : nothing}</dd>`,
    )}
  </dl>`;
}

function card(title: string, body: unknown, cls = "") {
  return html`<section class="card ${cls}">
    <h2>${title}</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------- top bar

function topbar(v: View) {
  const open = v.link.open;
  return html`<header class="topbar">
    <div class="brand"><img class="logo light" src=${logoBlue} alt="STAR" /><img class="logo dark" src=${logoWhite} alt="" /><span>STAR <b>Flight Computer</b></span></div>
    <label class="field-inline">
      <span>Port</span>
      <select
        aria-label="Port"
        ?disabled=${open}
        @change=${(e: Event) => send({ cmd: "select_port", port: (e.target as HTMLSelectElement).value })}
      >
        ${v.ports.map((p) => html`<option value=${p.dev} ?selected=${p.dev === v.port}>${p.label}</option>`)}
      </select>
    </label>
    <button class="ghost" ?disabled=${open} @click=${() => send({ cmd: "rescan" })}>Rescan</button>
    <button class=${open ? "" : "primary"} @click=${() => send({ cmd: open ? "disconnect" : "connect" })}>
      ${open ? "Disconnect" : "Connect"}
    </button>
    ${v.state ? chip(v.state[0], v.state[1]) : nothing}
    <span class="link-text ${v.link.heartbeat_lost ? "tone-text-bad" : ""}" role="status">${v.link.text}</span>
  </header>`;
}

function tabs(v: View) {
  return html`<nav class="tabs" role="tablist">
    ${TABS.filter(([t]) => t !== "ground" || v.ground.show).map(
      ([t, name]) =>
        html`<button role="tab" aria-selected=${ui.tab === t ? "true" : "false"} @click=${() => set({ tab: t })}>${name}</button>`,
    )}
  </nav>`;
}

// ---------------------------------------------------------------- status

function statusTab(s: StatusView) {
  return html`<div class="status-grid">
    <div class="col">${s.sections.map((sec) => card(sec.title, rows(sec.rows)))}</div>
    <div class="col">
      ${card(
        "Self-test",
        html`<ul class="selftest">
          ${s.self_test.map((r) => html`<li><span>${r.name}</span>${r.chip ? chip(r.value, r.chip) : html`<span class="muted">${r.value}</span>`}</li>`)}
        </ul>`,
      )}
      ${s.messages.length ? card("Board messages", html`<pre class="log">${s.messages.join("\n")}</pre>`) : nothing}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- live

function heartbeatTable(rows: HeartbeatRow[]) {
  const c = (x: [string, Tone] | null) => (x ? chip(x[0], x[1]) : nothing);
  return html`<section class="chart-card heartbeats" data-testid="heartbeats">
    <header><h3>Idle heartbeats <span class="unit">newest first</span></h3></header>
    ${rows.length
      ? html`<div class="heartbeat-scroll"><table>
          <thead><tr><th>#</th><th>Uptime</th><th>Battery</th><th></th><th>Self-test</th><th>Radio, last send</th></tr></thead>
          <tbody>${rows.map(
            (r) => html`<tr><td>${r.n}</td><td>${r.uptime}</td><td>${r.battery}</td><td>${c(r.battery_state)}</td><td>${r.chips}</td><td>${c(r.radio)}</td></tr>`,
          )}</tbody>
        </table></div>`
      : html`<p class="muted">Waiting for the first heartbeat (about every 10 s in Idle).</p>`}
  </section>`;
}

function liveTab(v: View) {
  const l = v.live;
  return html`<div class="live-layout">
    <aside class="readings" data-testid="readings">
      <h4 class="side-title">Flight stages</h4>
      <ol class="stages" data-testid="stages">
        ${v.stages.map(
          (s) => html`<li class="stage ${s.status}" title=${s.how ? `${s.does}\nNext on: ${s.how}` : s.does}>${s.name}</li>`,
        )}
      </ol>
      <h4 class="side-title">Current readings</h4>
      ${ui.readings.map(
        (r) => html`<div class="reading ${r.stale ? "stale" : ""}">
          <div class="reading-label">${r.label}</div>
          <div class="reading-values">
            ${r.values.map(([n, val]) => html`<span>${n ? html`<i>${n}</i>` : nothing}<b>${val}</b></span>`)}
            ${r.unit ? html`<span class="unit">${r.unit}</span>` : nothing}
          </div>
        </div>`,
      )}
    </aside>
    <div class="live-main">
    <div class="toolbar">
      <label class="field-inline">
        <span>Stream rate</span>
        <select
          aria-label="Stream rate"
          data-tip="How often the board sends live readings."
          @change=${(e: Event) => send({ cmd: "set_stream", rate: Number((e.target as HTMLSelectElement).value), mask: l.mask })}
        >
          ${l.rates.map((r) => html`<option value=${r.value} ?selected=${r.value === l.rate}>${r.label}</option>`)}
        </select>
      </label>
      <div class="toggles">
        ${l.sensors.map(
          ([bit, name]) => html`<label class="toggle">
            <input type="checkbox" .checked=${(l.mask & bit) !== 0} @change=${() => send({ cmd: "set_stream", rate: l.rate, mask: l.mask ^ bit })} />
            <span>${name}</span>
          </label>`,
        )}
      </div>
      <span class="spacer"></span>
      <button aria-pressed=${live.paused ? "true" : "false"} @click=${() => ((live.paused = !live.paused), draw())}>
        ${live.paused ? "Resume" : "Pause"}
      </button>
      <button class="ghost" @click=${() => live.clear()}>Clear</button>
    </div>
    ${l.error ? html`<p class="banner tone-bad">${l.error}</p>` : nothing}
    ${l.heartbeats ? heartbeatTable(l.heartbeats) : nothing}
    <div class="live-charts" ?hidden=${!l.show_graphs}>
      ${l.plots.map(
        (p, i) => html`<section class="chart-card">
          <header>
            <h3>${p.title} <span class="unit">${p.unit}</span></h3>
            ${p.series.length > 1
              ? html`<span class="legend">${p.series.map((s, j) => html`<span><i style="background:var(--s${j})"></i>${s}</span>`)}</span>`
              : nothing}
          </header>
          <div class="chart" data-live=${i}></div>
        </section>`,
      )}
    </div>
    </div>
    </div>`;
}

// ---------------------------------------------------------------- config

function editor(f: FieldView) {
  const id = `cfg-${f.key}`;
  if (f.kind === "mask")
    return html`<div class="mask" role="group" aria-labelledby=${`${id}-label`}>
      ${f.options.map(
        (o) => html`<label class="toggle">
          <input type="checkbox" .checked=${(f.value & o.value) !== 0} @change=${() => send({ cmd: "config_toggle", key: f.key, bit: o.value })} />
          <span>${o.label}</span>
        </label>`,
      )}
    </div>`;
  if (f.kind === "select")
    return html`<select
      id=${id}
      @change=${(e: Event) => send({ cmd: "config_edit", key: f.key, text: (e.target as HTMLSelectElement).value })}
    >
      ${f.options.map((o) => html`<option value=${o.value} ?selected=${o.value === f.value}>${o.label}</option>`)}
    </select>`;
  // Number boxes are filled after rendering (syncInputs) so a box being typed
  // in is never overwritten by a view that is a keystroke behind.
  return html`<span class="num ${f.error ? "invalid" : ""}">
    <input
      id=${id}
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      data-text=${f.text}
      @input=${(e: Event) => send({ cmd: "config_edit", key: f.key, text: (e.target as HTMLInputElement).value })}
    />${f.unit ? html`<span class="suffix">${f.unit}</span>` : nothing}
  </span>`;
}

function configTab(c: ConfigView) {
  return html`<div class="toolbar">
      <button ?disabled=${!c.can_read} @click=${() => send({ cmd: "config_read" })}>Read from board</button>
      <button
        class="primary"
        ?disabled=${!c.can_write}
        data-tip="Use these settings now. Lost on reboot."
        @click=${() => send({ cmd: "config_apply" })}
      >
        Apply to board
      </button>
      <button
        class="primary"
        ?disabled=${!c.can_write}
        data-tip="Apply, and keep them across reboots."
        @click=${() => send({ cmd: "config_save" })}
      >
        Save to flash
      </button>
      <button
        ?disabled=${!c.can_revert}
        data-tip="Go back to the board's saved settings."
        @click=${() => send({ cmd: "config_revert" })}
      >
        Revert board to saved
      </button>
      <span class="spacer"></span>
      <button
        class="ghost"
        data-tip="Fill in the firmware defaults. Nothing is sent."
        @click=${() => send({ cmd: "config_defaults" })}
      >
        Load defaults
      </button>
      <button class="ghost" @click=${() => pick("config_import")}>Import…</button>
      <button class="ghost" @click=${() => pick("config_export")}>Export…</button>
    </div>
    <p class="banner tone-${c.banner_tone ?? "neutral"}" data-testid="config-banner">${c.banner}</p>
    <div class="config-layout">
      <div class="config-groups">
        ${c.groups.map(
          (g) => html`<section class="card">
            <h2>${g.title}</h2>
            <table class="settings">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>New value</th>
                  <th>On the board</th>
                </tr>
              </thead>
              <tbody>
                ${g.fields.map(
                  (f) => html`<tr class=${f.differs ? "differs" : ""}>
                    <td>
                      <label for=${`cfg-${f.key}`} id=${`cfg-${f.key}-label`} data-tip=${f.help || nothing}>${f.label}</label>
                      ${f.help ? html`<span class="help" data-tip=${f.help}>?</span>` : nothing}
                    </td>
                    <td>${editor(f)}${f.error ? html`<div class="field-error">${f.error}</div>` : nothing}</td>
                    <td class="board">${f.board ?? "—"}${f.differs ? html` <span class="badge">differs</span>` : nothing}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </section>`,
        )}
      </div>
      <aside class="config-side">
        ${card(
          "Radio link",
          html`<p class="muted small">From the new values.</p>
            <dl class="rows mono">
              ${c.link.map(([k, val]) => html`<dt>${k}</dt><dd>${val}</dd>`)}
            </dl>`,
        )}
        ${card(
          "Checks",
          html`<ul class="checks" data-testid="checks">
            ${c.issues.map((i) => html`<li class="tone-text-bad">✕ ${i}</li>`)}
            ${c.notes.map((n) => html`<li class="tone-text-warn">! ${n}</li>`)}
            ${!c.issues.length && !c.notes.length ? html`<li class="tone-text-good">✓ Every value is allowed.</li>` : nothing}
          </ul>`,
        )}
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- flights

// ---------------------------------------------------------------- ground

function groundTab(g: GroundView) {
  const c = (x: [string, Tone] | null) => (x ? chip(x[0], x[1]) : html`<span class="muted">—</span>`);
  return html`<div class="ground" data-testid="ground">
    <div class="col">
      ${card(
        "Rocket",
        html`<dl class="rows">
            <dt>Rocket state</dt><dd>${c(g.rocket)}</dd>
            <dt>Last heard</dt><dd>${g.heard}</dd>
            <dt>Signal</dt><dd>${g.signal}</dd>
            <dt>Battery</dt><dd>${g.battery}</dd>
            ${g.telemetry ? html`<dt>Telemetry</dt><dd>${g.telemetry}</dd>` : nothing}
          </dl>
          <div class="ground-actions">
            ${ui.armConfirm
              ? html`<button class="danger" ?disabled=${g.busy} @click=${() => (set({ armConfirm: false }), send({ cmd: "ground_arm" }))}>
                    Confirm: arm the rocket
                  </button>
                  <button class="ghost" @click=${() => set({ armConfirm: false })}>Cancel</button>`
              : html`<button ?disabled=${g.busy} @click=${() => set({ armConfirm: true })}>Arm</button>`}
            <button ?disabled=${g.busy} @click=${() => send({ cmd: "ground_unarm" })}>Un-arm</button>
          </div>
          ${g.command ? html`<p class="muted" data-testid="ground-command">${g.command}</p>` : nothing}`,
      )}
      ${card(
        "Status report",
        g.chips.length
          ? html`<table class="ground-table">
                <thead><tr><th>Chip</th><th>Result</th><th>Read</th><th>Expected</th><th></th></tr></thead>
                <tbody>${g.chips.map(
                  (r) => html`<tr><td>${r.name}</td><td>${chip(r.result[0], r.result[1])}</td><td>${r.value}</td><td>${r.expected}</td><td class="muted">${r.when}</td></tr>`,
                )}</tbody>
              </table>
              <table class="ground-table">
                <thead><tr><th>ADC</th><th>Counts</th><th>At the pin</th><th></th></tr></thead>
                <tbody>${g.adc.map((r) => html`<tr><td>${r.name}</td><td>${r.counts}</td><td>${r.pin_v}</td><td>${r.value}</td></tr>`)}</tbody>
              </table>`
          : html`<p class="muted">Waiting for the rocket's first Status report (after each heartbeat, ~10 s in Idle).</p>`,
      )}
    </div>
    <div class="col">
      ${card(
        "Heard, newest first",
        html`<div class="ground-log"><table class="ground-table">
          <thead><tr><th>Time</th><th>Frame</th><th>Seq</th><th>Signal</th><th></th></tr></thead>
          <tbody>${g.log.map((r) => html`<tr><td>${r.t}</td><td>${r.kind}</td><td>${r.seq}</td><td>${r.rssi}</td><td>${r.summary}</td></tr>`)}</tbody>
        </table></div>`,
      )}
    </div>
  </div>`;
}

function flightsTab(f: FlightsView) {
  const sel = f.entries.find((e) => e.session === ui.selected) ?? null;
  const openRow = (s: number, downloaded: boolean) =>
    send(downloaded ? { cmd: "flight_open", session: s } : { cmd: "flight_download", session: s });
  return html`<div class="toolbar">
      <button ?disabled=${!f.can_refresh} @click=${() => send({ cmd: "flights_refresh" })}>Refresh</button>
      <button
        class="primary"
        ?disabled=${!f.can_download || !sel}
        @click=${() => sel && send({ cmd: "flight_download", session: sel.session })}
      >
        ${sel?.downloaded ? "Download again" : "Download"}
      </button>
      ${f.busy ? html`<button @click=${() => send({ cmd: "flight_cancel" })}>Cancel</button>` : nothing}
      <button ?disabled=${!sel?.downloaded} @click=${() => sel && send({ cmd: "flight_open", session: sel.session })}>View</button>
      <button ?disabled=${!sel?.downloaded} @click=${() => sel && send({ cmd: "flight_reveal", session: sel.session })}>Show in folder</button>
      <span class="spacer"></span>
      <button class="ghost" @click=${() => pick("flight_folder")}>Open a downloaded flight…</button>
      <button class="danger" ?disabled=${!f.can_wipe} @click=${() => set({ wipeOpen: true, wipeText: "" })}>Wipe card…</button>
    </div>
    <p class="muted" data-testid="flights-summary">${f.summary}</p>
    ${f.progress
      ? html`<div class="progress" role="progressbar" aria-valuenow=${Math.round(f.progress.fraction * 100)} aria-valuemin="0" aria-valuemax="100">
          <div style="width:${(f.progress.fraction * 100).toFixed(1)}%"></div>
          <span>${f.progress.text}</span>
        </div>`
      : nothing}
    <section class="card flush">
      <table class="flights">
        <thead>
          <tr>
            <th>Flight</th>
            <th>Started (UTC)</th>
            <th>Length</th>
            <th>Size</th>
            <th>On this computer</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${f.entries.length
            ? f.entries.map(
                (e) => html`<tr
                  class=${e.session === ui.selected ? "selected" : ""}
                  aria-selected=${e.session === ui.selected ? "true" : "false"}
                  @click=${() => set({ selected: e.session })}
                  @dblclick=${() => openRow(e.session, e.downloaded)}
                >
                  <td><b>${e.name}</b></td>
                  <td>${e.started}</td>
                  <td>${e.length}</td>
                  <td>${e.size}</td>
                  <td>${e.downloaded ? chip("downloaded", "good") : nothing}</td>
                  <td class="row-action">
                    ${e.downloaded
                      ? html`<button
                          class="small"
                          aria-label=${`View ${e.name}`}
                          @click=${(ev: Event) => (ev.stopPropagation(), set({ selected: e.session }), send({ cmd: "flight_open", session: e.session }))}
                        >
                          View
                        </button>`
                      : nothing}
                  </td>
                </tr>`,
              )
            : html`<tr class="empty">
                <td colspan="6">No flights listed.</td>
              </tr>`}
        </tbody>
      </table>
    </section>
    ${f.shown
      ? html`<div class="shown">
          <p data-testid="flight-detail">${f.shown.detail}</p>
          ${f.shown.warnings.map(([w, tone]) => html`<p class="banner tone-${tone}">${w}</p>`)}
          <p class="muted small">
            Files: <a href="#" @click=${(e: Event) => (e.preventDefault(), send({ cmd: "flight_reveal", session: null }))}>${f.shown.folder}</a>
            · drag to zoom, double-click to reset
          </p>
        </div>`
      : html`<p class="muted">Download a flight, or press View on a downloaded one, to plot it.</p>`}
    <div class="flight-charts" ?hidden=${!f.shown}>
      ${[0, 1, 2].map(
        (i) => html`<section class="chart-card"><header><h3 data-flight-title=${i}></h3><span class="legend" data-flight-legend=${i}></span></header><div class="chart" data-flight=${i}></div></section>`,
      )}
    </div>
    ${ui.wipeOpen ? wipeDialog(f) : nothing}`;
}

function wipeDialog(f: FlightsView) {
  const ok = ui.wipeText.trim() === f.wipe_word;
  return html`<div class="overlay">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="wipe-title">
      <h2 id="wipe-title">Wipe card</h2>
      <p>${f.wipe_warning}</p>
      <label class="stack">
        <span>Type ${f.wipe_word} to confirm</span>
        <input
          autofocus
          .value=${ui.wipeText}
          @input=${(e: Event) => set({ wipeText: (e.target as HTMLInputElement).value })}
        />
      </label>
      <div class="actions">
        <button @click=${() => set({ wipeOpen: false })}>Cancel</button>
        <button
          class="danger"
          ?disabled=${!ok}
          @click=${() => {
            send({ cmd: "flight_wipe", confirm: ui.wipeText });
            set({ wipeOpen: false, selected: null });
          }}
        >
          Wipe
        </button>
      </div>
    </div>
  </div>`;
}

function noticeDialog(v: View) {
  const n = v.notices[0];
  if (!n) return nothing;
  return html`<div class="overlay">
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="notice-title">
      <h2 id="notice-title">${n.title}</h2>
      <p class="pre">${n.text}</p>
      <div class="actions"><button class="primary" @click=${() => send({ cmd: "dismiss_notice" })}>OK</button></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- the page

function page(v: View): TemplateResult {
  // Every tab stays in the page (hidden when not shown) so the charts keep
  // their data and canvas across tab switches.
  return html`${topbar(v)}${tabs(v)}
    <main>
      <div class="panel" ?hidden=${ui.tab !== "status"}>${statusTab(v.status)}</div>
      <div class="panel live" ?hidden=${ui.tab !== "live"}>${liveTab(v)}</div>
      <div class="panel" ?hidden=${ui.tab !== "config"}>${configTab(v.config)}</div>
      <div class="panel" ?hidden=${ui.tab !== "flights"}>${flightsTab(v.flights)}</div>
      <div class="panel" ?hidden=${ui.tab !== "ground" || !v.ground.show}>${groundTab(v.ground)}</div>
    </main>
    ${noticeDialog(v)}`;
}

function syncInputs() {
  for (const el of root.querySelectorAll<HTMLInputElement>("input[data-text]")) {
    const text = el.dataset.text ?? "";
    if (el !== document.activeElement && el.value !== text) el.value = text;
  }
}

async function showFlight(id: number) {
  if (!id) return flight.destroy();
  if (id === flight.shownId) return;
  const plot = await api.flightPlot();
  if (!plot || plot.id !== id) return;
  plot.charts.forEach((c, i) => {
    root.querySelector(`[data-flight-title="${i}"]`)!.innerHTML = `${c.title} <span class="unit">${c.unit}</span>`;
    root.querySelector(`[data-flight-legend="${i}"]`)!.innerHTML =
      c.lines.length > 1 ? c.lines.map((l, j) => `<span><i style="background:var(--s${j})"></i>${l.name}</span>`).join("") : "";
  });
  flight.render(plot, [...root.querySelectorAll<HTMLElement>("[data-flight]")]);
}

function draw() {
  if (!view) return;
  render(page(view), root);
  syncInputs();
  live.mount(view.live.plots, [...root.querySelectorAll<HTMLElement>("[data-live]")]);
  void showFlight(view.flights.shown?.plot_id ?? 0);
}

/** Hover text for anything with `data-tip`. Drawn here because WebView2 does
 * not reliably show native `title` tooltips. */
function tooltips(): void {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  let shown: Element | null = null;
  const hide = () => {
    shown = null;
    tip.classList.remove("show");
  };
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as Element).closest?.("[data-tip]");
    if (el === shown) return;
    if (!el) return hide();
    shown = el;
    tip.textContent = el.getAttribute("data-tip");
    tip.classList.add("show");
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const below = r.bottom + 6 + h < innerHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - h}px`;
  });
  document.addEventListener("mousedown", hide);
  document.addEventListener("scroll", hide, true);
}

async function main() {
  try {
    api = await connect();
  } catch (e) {
    root.innerHTML = `<p class="fatal">${(e as Error).message}</p>`;
    return;
  }
  root.replaceChildren(); // the "Starting…" placeholder; lit appends to what is there
  await api.listen({
    view: (v) => {
      view = v;
      draw();
    },
    live: (b) => {
      live.push(b);
      set({ readings: b.readings });
    },
  });
  const v = await api.view();
  if (v && !view) {
    view = v;
    draw();
  }
  document.addEventListener("focusout", () => setTimeout(syncInputs));
  tooltips();
}

void main();
