import AVFoundation
import Charts
import HiDesKit
import SwiftUI

struct HiDesViewerApp: App {
    @StateObject private var receiver = ReceiverModel()
    @StateObject private var transmitter = TransmitterModel()

    init() {
        // Started from the command line there is no bundle, so ask for a normal window and Dock icon.
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        WindowGroup("HiDes Viewer") {
            HStack(spacing: 0) {
                VideoView(layer: receiver.displayLayer)
                    .frame(minWidth: 640, minHeight: 360)
                    .background(.black)
                    .overlay(alignment: .topTrailing) { ServiceNameBadge(name: receiver.snapshot?.serviceName) }
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ReceiverPanel(model: receiver)
                        Divider()
                        LinkDashboard(model: receiver)
                        Divider()
                        ScanPanel(model: receiver)
                        Divider()
                        DisclosureGroup("Bench setup (transmitter serial)") {
                            TransmitterPanel(model: transmitter).padding(.top, 8)
                        }
                        .font(.headline)
                    }
                    .padding()
                }
                .frame(width: 340)
            }
            .onAppear {
                let environment = ProcessInfo.processInfo.environment
                if let path = environment["HIDES_OPEN_TS"] {
                    receiver.startFile(URL(fileURLWithPath: path))
                } else if let megahertz = environment["HIDES_TUNE_MHZ"] {
                    receiver.frequencyMHz = megahertz
                    receiver.startDevice()
                }
            }
            .onDisappear { receiver.stop() }
        }
    }
}

/// Shows the name decoded from the received stream. Local display only, never transmitted.
private struct ServiceNameBadge: View {
    let name: String?

    var body: some View {
        if let name {
            Text(name)
                .font(.system(.title2, design: .monospaced).bold())
                .foregroundColor(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Color.black.opacity(0.65))
                .cornerRadius(6)
                .padding(12)
        }
    }
}

struct VideoView: NSViewRepresentable {
    let layer: AVSampleBufferDisplayLayer

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        layer.videoGravity = .resizeAspect
        view.layer = layer
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

@MainActor
final class ReceiverModel: ObservableObject {
    // Remembered between launches.
    @AppStorage("frequencyMHz") var frequencyMHz = "1280"
    @AppStorage("bandwidthMHz") var bandwidthMHz = "8"
    // 5600: the DAQ video gateway's first port for pushed streams (5600-5609), clear of the
    // DAQ's own UDP (5000, 5005, 5006, 5008). On the gateway machine itself this is right as
    // is; from another machine, use the gateway's name (the Video view's Edit shows it).
    @AppStorage("udpTarget") var udpTarget = "127.0.0.1:5600"
    @AppStorage("udpEnabled") var udpEnabled = false
    @AppStorage("logEnabled") var logEnabled = false
    @AppStorage("scanFromMHz") var scanFromMHz = "1240"
    @AppStorage("scanToMHz") var scanToMHz = "1300"
    @AppStorage("scanStepMHz") var scanStepMHz = "2"

    @Published var running = false
    @Published var playingFile: String?
    @Published var snapshot: LinkSnapshot?
    @Published var errorText: String?
    @Published var logPath: String?
    @Published var scanning = false
    @Published var scanPoints: [ScanPoint] = []
    @Published var scanMessage: String?

    let displayLayer = AVSampleBufferDisplayLayer()
    private let pipeline = LivePipeline()
    private var session: LinkSession?
    private var logger: LinkLogger?
    private var fileTask: Task<Void, Never>?
    private var fileTimer: Timer?

    var tunedFrequencyMHz: Double? { Double(frequencyMHz) }

    init() {
        let layer = displayLayer
        pipeline.onVideoSample = { sample in
            if layer.status == .failed { layer.flush() }
            layer.enqueue(sample)
        }
    }

    func startDevice() {
        errorText = nil
        guard let megahertz = Double(frequencyMHz), let bandwidth = Double(bandwidthMHz) else {
            errorText = "Enter frequency and bandwidth in MHz"
            return
        }
        do {
            try applyOutput()
            logger = logEnabled ? try LinkLogger(directory: LinkLogger.defaultDirectory) : nil
        } catch {
            errorText = "\(error)"
            return
        }
        logPath = logger?.url.path
        let session = LinkSession(pipeline: pipeline, frequencyKHz: UInt32(megahertz * 1000), bandwidthKHz: UInt16(bandwidth * 1000))
        let logger = logger
        session.onSnapshot = { [weak self] snapshot in
            logger?.append(snapshot)
            Task { @MainActor in self?.snapshot = snapshot }
        }
        let layer = displayLayer
        session.onRecovery = { _ in
            // A stale partial frame would otherwise stay on screen or fail decoding.
            DispatchQueue.main.async { layer.flush() }
        }
        self.session = session
        snapshot = LinkSnapshot()
        running = true
        session.start()
    }

    /// Feeds a recorded TS at a fixed byte rate, not its real bitrate, so everything past USB can be tried without hardware.
    func startFile(_ url: URL) {
        errorText = nil
        do { try applyOutput() } catch { errorText = "\(error)"; return }
        running = true
        playingFile = url.lastPathComponent
        pipeline.onServiceName = { name in Task { @MainActor [weak self] in self?.snapshot?.serviceName = name } }
        pipeline.onSourceInfo = { info in Task { @MainActor [weak self] in self?.snapshot?.sourceInfo = info } }
        snapshot = LinkSnapshot()
        let pipeline = pipeline
        fileTask = Task.detached(priority: .userInitiated) {
            guard let data = try? Data(contentsOf: url) else { return }
            let chunk = TS.packetSize * 50
            var offset = 0
            while offset < data.count, !Task.isCancelled {
                let end = min(offset + chunk, data.count)
                data[offset..<end].withUnsafeBytes { pipeline.ingest($0.bindMemory(to: UInt8.self)) }
                offset = end
                try? await Task.sleep(nanoseconds: 8_000_000)
            }
        }
        var lastStats = pipeline.stats
        fileTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            let stats = pipeline.stats
            let rates = StreamRates(from: lastStats, to: stats, seconds: 1)
            lastStats = stats
            Task { @MainActor in
                self?.snapshot?.rates = rates
                self?.snapshot?.stats = stats
            }
        }
    }

    func stop() {
        fileTimer?.invalidate()
        fileTask?.cancel()
        session?.stop()
        session = nil
        logger = nil
        pipeline.setOutput(nil)
        displayLayer.flushAndRemoveImage()
        snapshot = nil
        playingFile = nil
        running = false
    }

    /// Steps the receiver across the scan range. Needs the receiver free, so only while stopped.
    func scan() {
        guard !running, !scanning else { return }
        guard let from = Double(scanFromMHz), let to = Double(scanToMHz), let step = Double(scanStepMHz), step > 0,
              let bandwidth = Double(bandwidthMHz) else {
            scanMessage = "Enter the scan range in MHz"
            return
        }
        let frequencies = BandScanner.frequencies(fromKHz: UInt32(from * 1000), toKHz: UInt32(to * 1000), stepKHz: UInt32(step * 1000))
        scanPoints = []
        scanMessage = "Scanning \(frequencies.count) steps…"
        scanning = true
        Task.detached(priority: .userInitiated) { [weak self] in
            var message: String
            do {
                let device = try UT130Receiver()
                try device.initialize()
                let points = try BandScanner.scan(device, frequencies: frequencies, bandwidthKHz: UInt16(bandwidth * 1000)) { point in
                    Task { @MainActor in self?.scanPoints.append(point) }
                }
                if let peak = points.max(by: { $0.strengthDBm < $1.strengthDBm }) {
                    message = String(format: "Strongest %.1f MHz, %d dBm", Double(peak.frequencyKHz) / 1000, peak.strengthDBm)
                } else {
                    message = "No steps in range"
                }
            } catch {
                message = "\(error)"
            }
            let result = message
            await MainActor.run { [weak self] in
                self?.scanMessage = result
                self?.scanning = false
            }
        }
    }

    private func applyOutput() throws {
        guard udpEnabled else {
            pipeline.setOutput(nil)
            return
        }
        let parts = udpTarget.split(separator: ":")
        guard parts.count == 2, let port = UInt16(parts[1]) else {
            throw HiDesError.malformedReply("UDP target must be HOST:PORT")
        }
        pipeline.setOutput(try UDPOutput(host: String(parts[0]), port: port))
    }
}

private struct NumberRow: View {
    let title: String
    @Binding var text: String

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            TextField("", text: $text).frame(width: 80)
        }
    }
}

struct ReceiverPanel: View {
    @ObservedObject var model: ReceiverModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Receiver (UT-130)").font(.headline)
            NumberRow(title: "Frequency (MHz)", text: $model.frequencyMHz)
            NumberRow(title: "Bandwidth (MHz)", text: $model.bandwidthMHz)
            Toggle("Send to UDP", isOn: $model.udpEnabled)
            TextField("Host:port", text: $model.udpTarget)
                .disabled(!model.udpEnabled)
            Toggle("Log link to CSV", isOn: $model.logEnabled)
            startControls
            if let path = model.logPath, model.running {
                Text("Logging to \(path)").font(.caption).foregroundColor(.secondary).textSelection(.enabled)
            }
            Text(model.errorText ?? "").font(.caption).foregroundColor(.red)
        }
        .disabled(model.scanning)
    }

    @ViewBuilder
    private var startControls: some View {
        if model.running {
            Button("Stop") { model.stop() }
        } else {
            HStack {
                Button("Start") { model.startDevice() }
                Button("Open TS file…") { openFile() }
            }
        }
    }

    private func openFile() {
        let panel = NSOpenPanel()
        if panel.runModal() == .OK, let url = panel.url { model.startFile(url) }
    }
}

/// Receive-only link view: everything here comes from the UT-130, so it works with no transmitter cable.
struct LinkDashboard: View {
    @ObservedObject var model: ReceiverModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Link").font(.headline)
            if let snapshot = model.snapshot {
                if let file = model.playingFile {
                    Label("Playing \(file)", systemImage: "doc").font(.callout)
                } else {
                    StateBanner(state: snapshot.state)
                }
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    signalRows(snapshot)
                    streamRows(snapshot)
                    sourceRows(snapshot)
                    recoveryRows(snapshot)
                }
                .font(.callout)
                if let error = snapshot.error, snapshot.state != .healthy, model.playingFile == nil {
                    Text(error).font(.caption).foregroundColor(.secondary)
                }
            } else {
                Text("Stopped").foregroundColor(.secondary)
            }
        }
    }

    @ViewBuilder
    private func signalRows(_ snapshot: LinkSnapshot) -> some View {
        if let status = snapshot.status {
            Row("Strength", "\(status.strengthDBm) dBm (\(status.strengthPercent)%)")
            Row("Quality", "\(status.qualityPercent)%")
            if status.tpsLocked {
                Row("SNR", "\(status.snrDB) dB")
                Row("Bit errors", status.postViterbiBER.map { String(format: "%.1e after Viterbi", $0) } ?? "–")
                Row("Uncorrected", "\(status.uncorrectedPackets) packets")
            }
        }
        if let modulation = snapshot.modulation {
            Row("Modulation", modulation.summary)
        }
    }

    @ViewBuilder
    private func streamRows(_ snapshot: LinkSnapshot) -> some View {
        let rates = snapshot.rates
        if let capacity = snapshot.capacityBitsPerSecond {
            Row("Capacity", megabits(capacity))
            let used = capacity > 0 ? rates.payloadBitsPerSecond / capacity * 100 : 0
            Row("Video + audio", megabits(rates.payloadBitsPerSecond) + String(format: " (%.0f%%)", used))
            Row("Headroom", megabits(snapshot.headroomBitsPerSecond ?? 0))
        } else {
            Row("TS rate", megabits(rates.tsBitsPerSecond))
            Row("Video + audio", megabits(rates.payloadBitsPerSecond))
        }
        Row("Frame rate", String(format: "%.1f fps", rates.framesPerSecond))
        Row("Errors", "CC \(snapshot.stats.continuityErrors), TEI \(snapshot.stats.transportErrors)")
    }

    @ViewBuilder
    private func sourceRows(_ snapshot: LinkSnapshot) -> some View {
        if let name = snapshot.serviceName { Row("Service", name) }
        if let source = snapshot.sourceInfo {
            Row("Input", "\(source.width)×\(source.height), audio \(source.audioSampleRate / 1000) kHz")
        }
    }

    @ViewBuilder
    private func recoveryRows(_ snapshot: LinkSnapshot) -> some View {
        if model.playingFile == nil {
            let last = snapshot.lastAction.map { action in
                let time = snapshot.lastActionTime.map { $0.formatted(date: .omitted, time: .standard) } ?? ""
                return "\(action.title) at \(time)"
            }
            Row("Recoveries", "\(snapshot.recoveries)" + (last.map { ", last: \($0)" } ?? ""))
        }
    }

    private func megabits(_ value: Double) -> String { String(format: "%.2f Mbps", value / 1e6) }
}

private struct Row: View {
    let title: String
    let value: String

    init(_ title: String, _ value: String) {
        self.title = title
        self.value = value
    }

    var body: some View {
        GridRow {
            Text(title).foregroundColor(.secondary)
            Text(value).monospacedDigit().textSelection(.enabled)
        }
    }
}

/// State with an icon and words, so it does not rely on colour alone.
private struct StateBanner: View {
    let state: LinkState

    var body: some View {
        Label(state.title, systemImage: icon)
            .font(.title3.bold())
            .foregroundStyle(color)
    }

    private var icon: String {
        switch state {
        case .healthy: return "checkmark.circle.fill"
        case .connecting: return "hourglass"
        case .weakSignal, .noData, .noVideo: return "exclamationmark.triangle.fill"
        case .noSignal, .noDevice: return "xmark.octagon.fill"
        }
    }

    private var color: Color {
        switch state {
        case .healthy: return .green
        case .connecting: return .secondary
        case .weakSignal, .noData, .noVideo: return .orange
        case .noSignal, .noDevice: return .red
        }
    }
}

private extension LinkAction {
    var title: String {
        switch self {
        case .reopenDevice: return "reopened receiver"
        case .retune: return "retuned"
        case .restartStreaming: return "restarted stream"
        case .resynchronize: return "resynchronized"
        }
    }
}

/// Signal strength across a frequency range, for finding a clear channel or checking tuning.
struct ScanPanel: View {
    @ObservedObject var model: ReceiverModel
    @State private var hoverMHz: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Band scan").font(.headline)
            HStack {
                TextField("From", text: $model.scanFromMHz).frame(width: 60)
                Text("to")
                TextField("To", text: $model.scanToMHz).frame(width: 60)
                Text("step")
                TextField("Step", text: $model.scanStepMHz).frame(width: 40)
                Text("MHz")
            }
            Button(model.scanning ? "Scanning…" : "Scan") { model.scan() }
                .disabled(model.running || model.scanning)
            if model.running {
                Text("Stop receiving to scan.").font(.caption).foregroundColor(.secondary)
            }
            if !model.scanPoints.isEmpty { chart }
            if let message = model.scanMessage {
                Text(message).font(.caption).foregroundColor(.secondary)
            }
        }
    }

    private var hovered: ScanPoint? {
        guard let hoverMHz else { return nil }
        return model.scanPoints.min { abs(megahertz($0) - hoverMHz) < abs(megahertz($1) - hoverMHz) }
    }

    private var chart: some View {
        Chart {
            if let tuned = model.tunedFrequencyMHz {
                RuleMark(x: .value("Tuned", tuned))
                    .foregroundStyle(.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            ForEach(model.scanPoints, id: \.frequencyKHz) { point in
                LineMark(x: .value("Frequency (MHz)", megahertz(point)), y: .value("Strength (dBm)", point.strengthDBm))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .interpolationMethod(.linear)
            }
            ForEach(model.scanPoints.filter(\.mpegLocked), id: \.frequencyKHz) { point in
                PointMark(x: .value("Frequency (MHz)", megahertz(point)), y: .value("Strength (dBm)", point.strengthDBm))
                    .symbol(.diamond)
                    .symbolSize(64)
                    .annotation(position: .top) { Text("lock").font(.caption2).foregroundColor(.secondary) }
            }
            if let hovered {
                RuleMark(x: .value("Frequency (MHz)", megahertz(hovered)))
                    .foregroundStyle(.gray.opacity(0.5))
                    .annotation(position: .top, overflowResolution: .init(x: .fit, y: .disabled)) {
                        Text(String(format: "%.1f MHz  %d dBm%@", megahertz(hovered), hovered.strengthDBm, hovered.mpegLocked ? "  locked" : ""))
                            .font(.caption.monospacedDigit())
                            .padding(4)
                            .background(.background, in: RoundedRectangle(cornerRadius: 4))
                    }
            }
        }
        .chartXScale(domain: .automatic(includesZero: false))
        .chartYScale(domain: .automatic(includesZero: false))
        .chartXAxisLabel("MHz")
        .chartYAxisLabel("dBm")
        .chartXSelection(value: $hoverMHz)
        .frame(height: 180)
        .padding(.top, 16)
    }

    private func megahertz(_ point: ScanPoint) -> Double { Double(point.frequencyKHz) / 1000 }
}

@MainActor
final class TransmitterModel: ObservableObject {
    @Published var ports: [String] = []
    @Published var selectedPort = ""
    @Published var frequencyMHz = ""
    @Published var bandwidthMHz = ""
    @Published var attenuation = ""
    @Published var summary = ""
    @Published var message: String?

    private var client: AVSenderClient?
    private var config: TransmissionConfig?

    func refreshPorts() {
        ports = SerialPort.availablePorts()
        if !ports.contains(selectedPort) { selectedPort = ports.first ?? "" }
    }

    func read() {
        perform {
            let (client, baudRate) = try AVSenderClient.connect(path: selectedPort)
            self.client = client
            let config = try client.transmissionConfig()
            show(config)
            message = "Connected at \(baudRate) baud"
        }
    }

    func write() {
        perform {
            guard let client, var config else { return }
            guard let frequency = Double(frequencyMHz), let bandwidth = Double(bandwidthMHz), let decibels = Int8(attenuation) else {
                message = "Check the values entered"
                return
            }
            config.frequencyKHz = UInt32(frequency * 1000)
            config.channel = 0 // Channel 0 makes the box use this frequency, not a table entry.
            config.bandwidthKHz = Int(bandwidth * 1000)
            config.attenuationDB = decibels
            try client.setTransmissionConfig(config)
            show(try client.transmissionConfig())
            message = "Saved to transmitter"
        }
    }

    private func show(_ config: TransmissionConfig) {
        self.config = config
        frequencyMHz = String(Double(config.frequencyKHz) / 1000)
        bandwidthMHz = String(Double(config.bandwidthKHz) / 1000)
        attenuation = String(config.attenuationDB)
        summary = config.modulationSummary
    }

    private func perform(_ action: () throws -> Void) {
        do { try action() } catch { message = "\(error)" }
    }
}

struct TransmitterPanel: View {
    @ObservedObject var model: TransmitterModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Transmitter (HV-320)").font(.headline)
            portControls
            NumberRow(title: "Frequency (MHz)", text: $model.frequencyMHz)
            NumberRow(title: "Bandwidth (MHz)", text: $model.bandwidthMHz)
            NumberRow(title: "Attenuation (dB)", text: $model.attenuation)
            writeControls
        }
        .onAppear { model.refreshPorts() }
    }

    private var portControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Port", selection: $model.selectedPort) {
                ForEach(model.ports, id: \.self) { (port: String) in
                    Text(port).tag(port)
                }
            }
            HStack {
                Button("Rescan") { model.refreshPorts() }
                Button("Read") { model.read() }
                    .disabled(model.selectedPort.isEmpty)
            }
        }
    }

    private var writeControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button("Write to transmitter") { model.write() }
                .disabled(model.summary.isEmpty)
            Text(model.summary).font(.caption)
            Text(model.message ?? "").font(.caption).foregroundColor(.secondary)
        }
    }
}
