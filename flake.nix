{
  description = "DAQ Sensor System - Groundstation Flight Software";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        # Build the DAQ bridge
        daq-bridge = pkgs.stdenv.mkDerivation {
          name = "daq-bridge";
          src = ./.;
          
          nativeBuildInputs = with pkgs; [
            cmake
            pkg-config
          ];
          
          buildInputs = with pkgs; [
            eigen
            python3
            tmux
          ];
          
          cmakeFlags = [
            "-DCMAKE_BUILD_TYPE=Release"
          ];
          
          buildPhase = ''
            mkdir -p build
            cd build
            cmake ..
            make -j$(nproc) daq_bridge
          '';
          
          installPhase = ''
            mkdir -p $out/bin
            cp build/daq_bridge $out/bin/
            cp build/libdaq_comms_lib.so $out/lib/ || true
          '';
        };

        # Development shell
        devShell = pkgs.mkShell {
          name = "daq-system-dev";
          
          nativeBuildInputs = with pkgs; [
            cmake
            pkg-config
            gcc
            gdb
            clang-tools
          ];
          
          buildInputs = with pkgs; [
            eigen
            python3
            python3Packages.pyqt6
            tmux
            # Elodin binary (if available via cargo)
            # Note: You may need to install elodin separately via cargo install
          ];
          
          shellHook = ''
            echo "DAQ System Development Environment"
            echo "=================================="
            echo "Build: mkdir -p build && cd build && cmake .. && make"
            echo "Run: ./build/daq_bridge [udp_bind] [udp_port] [elodin_host] [elodin_port] [config]"
            echo ""
            echo "Elodin DB: elodin-db /tmp/elodin_test_db 2240"
            echo "Elodin Editor: elodin editor /tmp/elodin_test_db"
          '';
        };

      in
      {
        # Packages
        packages = {
          default = daq-bridge;
          daq-bridge = daq-bridge;
        };

        # Development shell
        devShells.default = devShell;

        # Apps (runnable via `nix run`)
        apps = {
          daq-bridge = flake-utils.lib.mkApp {
            drv = daq-bridge;
            exePath = "/bin/daq_bridge";
          };
        };
      }
    );
}

