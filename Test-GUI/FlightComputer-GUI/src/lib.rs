//! STAR flight computer bench app, everything but the window: the protocol,
//! config, decoding, the simulated board, the link, and the backend that turns
//! them into a worded view (src/backend). The Tauri app in src-tauri/ renders it.

pub mod backend;
pub mod config;
pub mod emmc;
pub mod fake_board;
pub mod link;
pub mod lora;
pub mod protocol;
pub mod records;
pub mod transport;
