//! STAR Flight Computer: the bench app's window.
//!
//!   star-fc-gui                 pick the board's port, then Connect
//!   star-fc-gui --sim           connect to the simulated board
//!   star-fc-gui --sim-flash F   keep the simulated board's flash in file F
//!
//! This file only joins the backend (star_fc::backend, where every rule and
//! every word on screen comes from) to the webview: commands in, `view` and
//! `live` events out, and the native file dialogs, which hand the backend a path.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use star_fc::backend::flights::FlightPlot;
use star_fc::backend::{Backend, Command, Options, Sink, View};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;

struct WebviewSink(AppHandle);

impl Sink for WebviewSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// None once the app is closing.
struct App(Mutex<Option<Backend>>);

impl App {
    fn with<T>(&self, f: impl FnOnce(&Backend) -> T) -> Option<T> {
        self.0.lock().unwrap().as_ref().map(f)
    }
}

#[tauri::command]
fn send(app: tauri::State<App>, command: Command) {
    app.with(|b| b.send(command));
}

#[tauri::command]
fn view(app: tauri::State<App>) -> Option<View> {
    app.with(|b| b.view())
}

#[tauri::command]
fn flight_plot(app: tauri::State<App>) -> Option<FlightPlot> {
    app.with(|b| b.flight_plot()).flatten()
}

/// Open a native file dialog, then send the backend the command for the path
/// chosen. `what` is config_import, config_export or flight_folder.
#[tauri::command]
async fn pick(handle: AppHandle, what: String) -> Result<(), String> {
    let state = handle.state::<App>();
    let root = state.with(|b| PathBuf::from(b.view().flights.root));
    let dialog = handle.dialog().file();
    let path = match what.as_str() {
        "config_import" => dialog.add_filter("JSON", &["json"]).blocking_pick_file(),
        "config_export" => dialog.add_filter("JSON", &["json"]).set_file_name("flight-computer-config.json").blocking_save_file(),
        "flight_folder" => {
            let d = match root.filter(|r| r.is_dir()) {
                Some(r) => dialog.set_directory(r),
                None => dialog,
            };
            d.blocking_pick_folder()
        }
        other => return Err(format!("unknown dialog {other}")),
    };
    let Some(path) = path else { return Ok(()) }; // cancelled
    let path = path.into_path().map_err(|e| e.to_string())?;
    let command = match what.as_str() {
        "config_import" => Command::ConfigImport { path },
        "config_export" => Command::ConfigExport { path },
        _ => Command::FlightOpenFolder { path },
    };
    state.with(|b| b.send(command));
    Ok(())
}

fn main() {
    let mut opts = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--sim" => opts.connect_sim = true,
            "--sim-flash" => {
                if let Some(f) = args.next() {
                    opts.sim_flash = PathBuf::from(f);
                }
            }
            "-h" | "--help" => {
                println!("usage: star-fc-gui [--sim] [--sim-flash FILE]");
                return;
            }
            other => {
                eprintln!("unknown argument {other}; try --help");
                std::process::exit(2);
            }
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let sink = Arc::new(WebviewSink(app.handle().clone()));
            app.manage(App(Mutex::new(Some(Backend::start(opts, sink)))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send, view, flight_plot, pick])
        .build(tauri::generate_context!())
        .expect("start the window");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Close the port (drops DTR, so the board stops streaming).
            if let Some(mut b) = handle.state::<App>().0.lock().unwrap().take() {
                b.stop();
            }
        }
    });
}
