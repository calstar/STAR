import threading
import numpy as np
import socket
import struct
from collections import deque
import csv
import time
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from os.path import isfile

# DAQv2-Comms protocol constants (from pt_multi_gui)
MAX_PACKET_SIZE = 512
PACKET_TYPE_SENSOR_DATA = 3
PACKET_HEADER_FORMAT = "<BBI"
PACKET_HEADER_SIZE = 6
SENSOR_DATA_PACKET_FORMAT = "<BB"
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"  # uint8_t sensor_id + uint32_t data (ADC code)
SENSOR_DATAPOINT_SIZE = 5

def parse_packet_header(data):
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        return struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
    except struct.error:
        return None

def parse_sensor_data_packet(data):
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
        return None
    header = parse_packet_header(data)
    if header is None or header[0] != PACKET_TYPE_SENSOR_DATA:
        return None
    packet_type, version, timestamp = header
    offset = PACKET_HEADER_SIZE
    try:
        num_chunks, num_sensors = struct.unpack(
            SENSOR_DATA_PACKET_FORMAT,
            data[offset : offset + SENSOR_DATA_PACKET_SIZE],
        )
    except struct.error:
        return None
    offset += SENSOR_DATA_PACKET_SIZE
    per_chunk = SENSOR_DATA_CHUNK_SIZE + num_sensors * SENSOR_DATAPOINT_SIZE
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + num_chunks * per_chunk:
        return None
    chunks = []
    for _ in range(num_chunks):
        chunk_ts, = struct.unpack(SENSOR_DATA_CHUNK_FORMAT, data[offset : offset + SENSOR_DATA_CHUNK_SIZE])
        offset += SENSOR_DATA_CHUNK_SIZE
        datapoints = []
        for _ in range(num_sensors):
            sid, val = struct.unpack(SENSOR_DATAPOINT_FORMAT, data[offset : offset + SENSOR_DATAPOINT_SIZE])
            datapoints.append({"sensor_id": sid, "data": val})
            offset += SENSOR_DATAPOINT_SIZE
        chunks.append({"timestamp": chunk_ts, "datapoints": datapoints})
    return ({"packet_type": packet_type, "version": version, "timestamp": timestamp}, chunks)

# Exponential Moving Average Filter
def ema(data, alpha=0.5):
    if len(data) < 2:
        return data[-1]
    ema_filtered = data[0]
    for d in data[1:]:
        ema_filtered = alpha * d + (1 - alpha) * ema_filtered
    return ema_filtered

# Use polynomial coefficients to calculate pressure from ADC code
def calculate_pressure_from_polynomial(adc_code, poly_coeffs):
    return np.polyval(poly_coeffs, adc_code)

# Moving Average Filter (with Standard Deviation-based Outlier Removal)
def filtered_sensor_data(data, window=5, std_threshold=2):
    if len(data) < window:
        return data[-1]
    window_data = np.array(data[-window:])
    mean = np.mean(window_data)
    std = np.std(window_data)
    filtered_data = [d for d in window_data if (mean - std_threshold * std) <= d <= (mean + std_threshold * std)]
    return np.mean(filtered_data) if filtered_data else mean

def apply_dual_filter(data, ema_alpha=0.1, ma_window=250, std_threshold=0.001):
    ema_filtered = ema(data, alpha=ema_alpha)
    ma_filtered = filtered_sensor_data([ema_filtered], window=ma_window, std_threshold=std_threshold)
    return ma_filtered

# Global variables
instrument_deques = []
filtered_code_deques = []
pressure_deques = []
calibration_polynomials = []
instrument_to_connector = []  # Filled at startup: instrument_to_connector[i] = board connector (1-10) for PT i+1
gauge_mappings = {}  # Dictionary to store which PTs are connected to which gauge
gauge_pressures = {}  # Dictionary to store pressure readings for each gauge
keep_calibrating = True
stop_serial_thread = threading.Event()
pause_reading = threading.Event()
X = []
Y = {}  # Modified to store pressure readings per gauge

# Modified read_udp function to receive DAQv2-Comms packets over UDP
def read_udp(port=5006, bind_address="0.0.0.0"):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # Try to enable SO_REUSEPORT for multiple listeners (Linux/macOS)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except (AttributeError, OSError):
        pass  # Not available on Windows
    sock.settimeout(0.1)
    
    try:
        sock.bind((bind_address, port))
        print(f"Listening for PT data on {bind_address}:{port}")
    except OSError as e:
        print(f"Error binding to port {port}: {e}")
        print("Make sure pt_multi_gui is not already running, or that SO_REUSEPORT is supported.")
        return
    
    try:
        while not stop_serial_thread.is_set():
            if not pause_reading.is_set():
                try:
                    data, _ = sock.recvfrom(MAX_PACKET_SIZE)
                    result = parse_sensor_data_packet(data)
                    if result:
                        header, chunks = result
                        # Extract ADC codes and map connector -> instrument
                        # Stream_ADC: sensor_id = connector (1-10). PT_BOARD_Multi: sensor_id = 0-9 (connector - 1).
                        for chunk in chunks:
                            for dp in chunk["datapoints"]:
                                sid = int(dp["sensor_id"])
                                connector = sid if 1 <= sid <= 10 else (sid + 1)  # 1-10
                                adc_code = int(dp["data"])  # Get ADC code as uint32
                                
                                try:
                                    inst_idx = instrument_to_connector.index(connector)
                                    if inst_idx < len(instrument_deques):
                                        instrument_deques[inst_idx].append(adc_code)
                                except ValueError:
                                    pass
                        
                        # Process filtered ADC codes and pressures
                        filtered_codes = []
                        pressure_readings = []
                        for j in range(len(instrument_deques)):
                            if len(instrument_deques[j]) > 0:
                                filtered_code = apply_dual_filter(list(instrument_deques[j]))
                                filtered_code_deques[j].append(filtered_code)
                                filtered_codes.append(filtered_code)
                                
                                calculated_pressure = calculate_pressure_from_polynomial(filtered_code, calibration_polynomials[j])
                                pressure_deques[j].append(calculated_pressure)
                                filtered_pressure = apply_dual_filter(list(pressure_deques[j]))
                                pressure_readings.append(filtered_pressure)

                        code_output = " | ".join([f"PT {j+1}: {code:.0f}" for j, code in enumerate(filtered_codes)])
                        print("Filtered ADC code readings:", code_output)

                        pressure_output = " | ".join([f"PT {j+1}: {pressure:.3f} psi" for j, pressure in enumerate(pressure_readings)])
                        print("Calculated pressures:", pressure_output)

                except socket.timeout:
                    continue
                except Exception as e:
                    print(f"Error processing data: {e}")
                    continue

    except KeyboardInterrupt:
        print("UDP reading interrupted.")
    finally:
        sock.close()

def get_gauge_pressures(num_gauges):
    while True:
        try:
            pressure_input = input(f"Enter the {num_gauges} pressure gauge readings (comma-separated): ")
            pressures = [float(p.strip()) for p in pressure_input.split(',')]
            if len(pressures) != num_gauges:
                print(f"Please enter exactly {num_gauges} pressure readings.")
                continue
            return pressures
        except ValueError:
            print("Invalid input. Please enter valid numbers separated by commas.")
        except KeyboardInterrupt:
            print("\nInput interrupted. Please try again.")

def interrupt():
    global X, Y

    # Get pressure readings for each gauge
    pressures = get_gauge_pressures(len(gauge_pressures))
    
    # Update pressure readings for each gauge
    for gauge_num, pressure in enumerate(pressures, 1):
        gauge_pressures[gauge_num] = pressure
        if gauge_num not in Y:
            Y[gauge_num] = []
        Y[gauge_num].append(pressure)

    # Update ADC code readings for each PT
    for pt_num in range(len(instrument_deques)):
        if pt_num >= len(X):
            X.append([])
        X[pt_num].append(apply_dual_filter(list(instrument_deques[pt_num])))

    # Update calibration polynomials
    if all(len(Y[gauge]) > 1 for gauge in Y):
        for pt_num in range(len(instrument_deques)):
            try:
                gauge_num = gauge_mappings[pt_num + 1]  # Get the gauge number for this PT
                epsilon = 1e-10
                calibration_polynomials[pt_num] = np.polyfit(
                    np.array(X[pt_num]) + epsilon,
                    np.array(Y[gauge_num]) + epsilon,
                    poly_order
                )
                print(f"Updated polynomial coefficients for PT {pt_num + 1}: {calibration_polynomials[pt_num]}")
            except np.RankWarning:
                print(f"Warning: The fit may be poorly conditioned for PT {pt_num + 1}.")
            except Exception as e:
                print(f"Error fitting polynomial for PT {pt_num + 1}: {e}")

        plot_data_with_trendline()
        save_calibration_data()
    else:
        print("Not enough data to fit a curve yet. Please enter at least one more data point.")

def save_calibration_data():
    with open(filename, "a", newline='') as f:
        writer = csv.writer(f, delimiter=",")
        
        # Create a row with current calibration point data
        row = []
        for pt_num in range(len(instrument_deques)):
            gauge_num = gauge_mappings[pt_num + 1]
            # Add ADC code, pressure, and coefficients for this PT
            row.extend([
                X[pt_num][-1],  # ADC Code
                Y[gauge_num][-1]  # Pressure
            ])
            row.extend(calibration_polynomials[pt_num])  # Coefficients
        writer.writerow(row)

def plot_data_with_trendline():
    num_cols = 2
    num_rows = (len(instrument_deques) + 1) // num_cols

    fig, axs = plt.subplots(num_rows, num_cols, figsize=(12, 6), squeeze=False)

    for pt_num in range(len(instrument_deques)):
        x = np.array(X[pt_num])
        gauge_num = gauge_mappings[pt_num + 1]
        y = np.array(Y[gauge_num])

        poly_coeffs = calibration_polynomials[pt_num]
        trendline_y = np.polyval(poly_coeffs, x)

        ss_res = np.sum((y - trendline_y) ** 2)
        ss_tot = np.sum((y - np.mean(y)) ** 2)
        r_squared = 1 - (ss_res / ss_tot)

        row, col = divmod(pt_num, num_cols)
        axs[row, col].scatter(x, y, color='purple', label='Data Points')
        axs[row, col].plot(x, trendline_y, color='blue', linestyle='--', label=f'Trendline (R² = {r_squared:.3f})')

        axs[row, col].set_title(f"PT {pt_num + 1} (Gauge {gauge_num})")
        axs[row, col].set_xlabel('ADC Code')
        axs[row, col].set_ylabel('Pressure (psi)')
        axs[row, col].legend()

    plt.tight_layout()
    plt.show()


# Live feed function modified to plot only filtered data
def live_feed(save_count=500):
    num_cols = 2
    num_rows = (len(instrument_deques) + 1) // num_cols

    fig, axs = plt.subplots(num_rows, num_cols, figsize=(12, 6), squeeze=False)
    times = deque(maxlen=save_count)
    pressure_data = [deque(maxlen=save_count) for _ in range(len(instrument_deques))]

    start_time = time.time()

    def update(frame):
        current_time = time.time() - start_time
        times.append(current_time)

        for j in range(len(instrument_deques)):
            if instrument_deques[j]:  # Check if there's data in the deque
                filtered_value = apply_dual_filter(list(instrument_deques[j]))
                calculated_pressure = calculate_pressure_from_polynomial(filtered_value, calibration_polynomials[j])
                pressure_data[j].append(calculated_pressure)

            row, col = divmod(j, num_cols)
            axs[row, col].clear()
            axs[row, col].plot(list(times), list(pressure_data[j]), label=f'Instrument {j+1} Pressure', color='blue')

            axs[row, col].set_xlabel('Time (seconds)')
            axs[row, col].set_ylabel('Calibrated Pressure (psi)')
            axs[row, col].legend(loc='upper left')
            axs[row, col].set_title(f'Live Pressure Readings for Instrument {j+1}')

        fig.tight_layout()

    ani = FuncAnimation(fig, update, interval=100, frames=None, repeat=True)
    plt.show()


if __name__ == "__main__":
    # Get number of PTs
    while True:
        try:
            instrument_count = int(input("Please input the number of PTs for calibration: "))
            break
        except ValueError:
            print("Invalid input. Please enter an integer.")

    # Get connector for each PT
    print("\nFor each PT, specify which board connector (1-10) it is connected to:")
    for pt_num in range(1, instrument_count + 1):
        while True:
            try:
                conn = int(input(f"Enter board connector (1-10) for PT {pt_num}: "))
                if 1 <= conn <= 10:
                    instrument_to_connector.append(conn)
                    break
                else:
                    print("Please enter a valid connector between 1 and 10.")
            except ValueError:
                print("Invalid input. Please enter an integer.")

    # Get number of gauges
    while True:
        try:
            gauge_count = int(input("Please input the number of pressure gauges: "))
            break
        except ValueError:
            print("Invalid input. Please enter an integer.")

    # Get PT to gauge mapping
    print("\nFor each PT, specify which gauge it's connected to:")
    for pt_num in range(1, instrument_count + 1):
        while True:
            try:
                gauge_num = int(input(f"Enter gauge number (1-{gauge_count}) for PT {pt_num}: "))
                if 1 <= gauge_num <= gauge_count:
                    gauge_mappings[pt_num] = gauge_num
                    break
                else:
                    print(f"Please enter a valid gauge number between 1 and {gauge_count}")
            except ValueError:
                print("Invalid input. Please enter an integer.")

    # Initialize gauge pressure dictionary
    gauge_pressures = {i: 0 for i in range(1, gauge_count + 1)}

    # Get polynomial order
    while True:
        try:
            poly_order = int(input("Enter the polynomial order for the fit (e.g., 1 for linear, 2 for quadratic, etc.): "))
            break
        except ValueError:
            print("Invalid input. Please enter an integer.")

    data_point_num = 6

    # Initialize data structures
    instrument_deques = [deque(maxlen=data_point_num) for _ in range(instrument_count)]
    calibration_polynomials = [[0] * (poly_order + 1) for _ in range(instrument_count)]
    filtered_code_deques = [deque(maxlen=data_point_num) for _ in range(instrument_count)]
    pressure_deques = [deque(maxlen=data_point_num) for _ in range(instrument_count)]
    X = [[] for _ in range(instrument_count)]
    Y = {i: [] for i in range(1, gauge_count + 1)}

    # Set up CSV file
    # Set up CSV file
    file_base = f"PT Calibration Attempt {time.strftime('%Y-%m-%d', time.gmtime())}"
    file_ext = ".csv"
    test_num = 1

    while isfile(file_base + f"_test{test_num}" + file_ext):
        test_num += 1

    filename = file_base + f"_test{test_num}" + file_ext

    # Write CSV header
    # Use connector numbers in the header so tools like combined_gui.py
    # can map calibration data directly by connector ID.
    with open(filename, "w", newline='') as f:
        writer = csv.writer(f, delimiter=",")
        header = []
        for pt_index in range(instrument_count):
            connector_id = instrument_to_connector[pt_index]
            base_label = f"PT{connector_id}"
            pt_header = [
                f"{base_label} ADC Code",
                f"{base_label} Pressure",
            ]
            pt_header.extend([f"{base_label} Coefficient {k}" for k in range(poly_order + 1)])
            header.extend(pt_header)
        writer.writerow(header)

    # Start UDP reading thread
    udp_thread = threading.Thread(target=read_udp, args=(5006, "0.0.0.0"))
    udp_thread.daemon = True
    udp_thread.start()

    print("\nPress Ctrl+C to enter new pressure gauge readings.")
    print(f"When prompted, enter {gauge_count} comma-separated pressure values.")
    
    calibration_count = 0
    continue_calibration = True
    while continue_calibration:
        try:
            pause_reading.clear()
            while True:
                time.sleep(0.1)
        except KeyboardInterrupt:
            print("\nEntering calibration mode...")
            pause_reading.set()
            time.sleep(0.2)
            
            interrupt()
            calibration_count += 1
            
            while True:
                try:
                    user_input = input("Would you like to continue calibrating? (y/n): ").strip().lower()
                    if user_input == 'y':
                        break
                    elif user_input == 'n':
                        continue_calibration = False
                        break
                    else:
                        print("Invalid input. Please enter 'y' or 'n'.")
                except KeyboardInterrupt:
                    print("\nInput interrupted. Please try again.")

    # Stop the UDP thread
    stop_serial_thread.set()
    udp_thread.join()

    print("Calibration complete.")
    show_live_feed = input("Would you like to see a live feed of the calibrated pressure readings vs time? (y/n): ").strip().lower()
    if show_live_feed == 'y':
        stop_serial_thread.clear()
        pause_reading.clear()
        udp_thread = threading.Thread(target=read_udp, args=(5006, "0.0.0.0"))
        udp_thread.daemon = True
        udp_thread.start()

        live_feed()

        stop_serial_thread.set()
        udp_thread.join()

print("Program terminated.")