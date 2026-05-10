#!/usr/bin/env python3
"""
Simple Serial Interface for Actuator Control
Controls the ESP32 actuator and reads current sensor data via Serial
"""

import serial
import serial.tools.list_ports
import time
import sys

BAUD_RATE = 115200

def list_ports():
    """List all available serial ports"""
    ports = serial.tools.list_ports.comports()
    return [p.device for p in ports]

def connect_to_device(port=None):
    """Connect to the ESP32 device"""
    if port is None:
        ports = list_ports()
        if not ports:
            print("No serial ports found!")
            return None
        
        print("Available ports:")
        for i, p in enumerate(ports):
            print(f"  {i+1}. {p}")
        
        try:
            choice = input("\nSelect port number (or enter port name): ").strip()
            if choice.isdigit():
                port = ports[int(choice) - 1]
            else:
                port = choice
        except (ValueError, IndexError):
            print("Invalid selection!")
            return None
    
    try:
        ser = serial.Serial(port, BAUD_RATE, timeout=1)
        time.sleep(2)  # Wait for device to initialize
        print(f"Connected to {port} at {BAUD_RATE} baud")
        return ser
    except serial.SerialException as e:
        print(f"Error connecting to {port}: {e}")
        return None

def send_command(ser, command):
    """Send a command to the device"""
    if ser and ser.is_open:
        ser.write((command + '\n').encode())
        print(f"Sent: {command}")

def read_responses(ser, timeout=2):
    """Read responses from the device"""
    if not ser or not ser.is_open:
        return
    
    start_time = time.time()
    while time.time() - start_time < timeout:
        if ser.in_waiting > 0:
            line = ser.readline().decode('utf-8', errors='ignore').strip()
            if line:
                print(f"Device: {line}")
        time.sleep(0.1)

def interactive_mode(ser):
    """Interactive command mode"""
    print("\n" + "="*50)
    print("Interactive Actuator Control")
    print("="*50)
    print("Commands:")
    print("  ACTUATE:HIGH  - Set actuator to HIGH")
    print("  ACTUATE:LOW   - Set actuator to LOW")
    print("  ACTUATE:OFF   - Turn actuator OFF")
    print("  STATUS        - Get current status")
    print("  HELP          - Show help (on device)")
    print("  QUIT or EXIT  - Exit program")
    print("="*50 + "\n")
    
    while True:
        try:
            command = input("Enter command: ").strip().upper()
            
            if command in ['QUIT', 'EXIT', 'Q']:
                break
            
            if command:
                send_command(ser, command)
                read_responses(ser, timeout=1)
        
        except KeyboardInterrupt:
            print("\nExiting...")
            break
        except Exception as e:
            print(f"Error: {e}")

def main():
    """Main function"""
    port = None
    if len(sys.argv) > 1:
        port = sys.argv[1]
    
    ser = connect_to_device(port)
    if not ser:
        return
    
    try:
        # Read initial messages from device
        print("\nReading device startup messages...")
        read_responses(ser, timeout=3)
        
        # Enter interactive mode
        interactive_mode(ser)
    
    finally:
        if ser and ser.is_open:
            ser.close()
            print("Disconnected from device")

if __name__ == "__main__":
    main()

