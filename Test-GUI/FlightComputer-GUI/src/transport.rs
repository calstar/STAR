//! Byte pipes to a flight computer: the real board's USB serial port, or the
//! in-process simulator. Both look the same to the link thread.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use crate::fake_board::{self, FakeBoard};

pub const SIM_PORT: &str = "sim://flight-computer";
pub const SIM_LABEL: &str = "Simulated flight computer";

/// STMicroelectronics' USB vendor ID; the board's CDC port enumerates under it
/// (ST's CDC class default VID). Sorted first in the port list.
pub const ST_VID: u16 = 0x0483;

pub trait Transport: Send {
    fn open(&mut self) -> io::Result<()>;
    /// Whatever has arrived; may block briefly (tens of ms) and return nothing.
    fn read(&mut self) -> io::Result<Vec<u8>>;
    fn write(&mut self, data: &[u8]) -> io::Result<()>;
    fn close(&mut self);
}

/// (device, description), likely boards first, then the simulator.
pub fn list_ports() -> Vec<(String, String)> {
    let mut ports: Vec<(u8, String, String)> = Vec::new();
    for info in serialport::available_ports().unwrap_or_default() {
        let (rank, desc) = match &info.port_type {
            serialport::SerialPortType::UsbPort(u) => {
                let desc =
                    u.product.clone().or_else(|| u.manufacturer.clone()).unwrap_or_else(|| format!("USB {:04x}:{:04x}", u.vid, u.pid));
                (if u.vid == ST_VID { 0 } else { 1 }, desc)
            }
            serialport::SerialPortType::BluetoothPort => continue,
            _ => (2, String::new()),
        };
        let blob = format!("{} {}", info.port_name, desc).to_lowercase();
        if blob.contains("bluetooth") || blob.contains("bthenum") {
            continue;
        }
        // macOS lists each port twice (tty.* and cu.*); cu.* is the one to open.
        if info.port_name.starts_with("/dev/tty.") {
            continue;
        }
        let rank = if rank == 2 && (blob.contains("usbmodem") || blob.contains("acm")) { 1 } else { rank };
        ports.push((rank, info.port_name.clone(), if desc.is_empty() { info.port_name } else { desc }));
    }
    ports.sort();
    let mut out: Vec<(String, String)> = ports.into_iter().map(|(_, d, s)| (d, s)).collect();
    out.push((SIM_PORT.into(), SIM_LABEL.into()));
    out
}

pub struct SerialTransport {
    pub port: String,
    s: Option<Box<dyn serialport::SerialPort>>,
}

impl SerialTransport {
    pub fn new(port: &str) -> Self {
        Self { port: port.into(), s: None }
    }
}

impl Transport for SerialTransport {
    fn open(&mut self) -> io::Result<()> {
        // The baud rate means nothing to a USB CDC port; the board ignores it.
        let mut s = serialport::new(&self.port, 115_200).timeout(Duration::from_millis(50)).open()?;
        // DTR is how the board knows a host has the port open (PROTOCOL.md §4).
        s.write_data_terminal_ready(true)?;
        self.s = Some(s);
        Ok(())
    }

    fn read(&mut self) -> io::Result<Vec<u8>> {
        let s = self.s.as_mut().ok_or_else(|| io::Error::other("port not open"))?;
        let mut buf = vec![0u8; 4096];
        match s.read(&mut buf) {
            Ok(n) => {
                buf.truncate(n);
                Ok(buf)
            }
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    fn write(&mut self, data: &[u8]) -> io::Result<()> {
        let s = self.s.as_mut().ok_or_else(|| io::Error::other("port not open"))?;
        s.write_all(data)?;
        s.flush()
    }

    fn close(&mut self) {
        if let Some(mut s) = self.s.take() {
            let _ = s.write_data_terminal_ready(false);
        }
    }
}

pub struct SimTransport {
    pub board: FakeBoard,
}

impl SimTransport {
    pub fn new(flash_path: Option<PathBuf>) -> Self {
        Self { board: FakeBoard::new(flash_path, fake_board::monotonic()) }
    }
}

impl Transport for SimTransport {
    fn open(&mut self) -> io::Result<()> {
        self.board.dtr = true;
        Ok(())
    }
    fn read(&mut self) -> io::Result<Vec<u8>> {
        std::thread::sleep(Duration::from_millis(10));
        self.board.tick();
        Ok(self.board.host_read())
    }
    fn write(&mut self, data: &[u8]) -> io::Result<()> {
        self.board.host_write(data);
        Ok(())
    }
    fn close(&mut self) {
        self.board.dtr = false;
    }
}
