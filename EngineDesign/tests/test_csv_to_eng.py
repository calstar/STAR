"""
Tests for csv_to_eng module.
"""

import tempfile
from pathlib import Path

import pytest

from csv_to_eng import (
    EngineMetadata,
    read_csv_curve,
    normalize_curve,
    write_eng,
    convert,
    LBF_TO_N,
)


class TestEngineMetadata:
    """Tests for EngineMetadata dataclass."""

    def test_default_values(self):
        meta = EngineMetadata()
        assert meta.name == "Unknown"
        assert meta.diameter_mm == 0.0
        assert meta.manufacturer == "Unknown"

    def test_header_line(self):
        meta = EngineMetadata(
            name="K1000",
            diameter_mm=54,
            length_mm=326,
            delays="6-10-14",
            prop_mass_kg=0.85,
            total_mass_kg=1.45,
            manufacturer="Acme Rocketry",
        )
        header = meta.header_line()
        assert header == "K1000 54 326 6-10-14 0.8500 1.4500 Acme_Rocketry"

    def test_header_line_spaces_replaced(self):
        meta = EngineMetadata(name="My Motor", manufacturer="Space Co")
        header = meta.header_line()
        assert "My_Motor" in header
        assert "Space_Co" in header


class TestReadCSVCurve:
    """Tests for read_csv_curve function."""

    def test_basic_csv(self):
        csv_content = """time,thrust
0.0,0.0
0.1,100.5
0.2,150.2
0.3,0.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert len(points) == 4
            assert points[0] == (0.0, 0.0)
            assert points[1] == (0.1, 100.5)
            assert points[3] == (0.3, 0.0)
        finally:
            Path(csv_path).unlink()

    def test_alternative_column_names(self):
        csv_content = """t,F
0.0,50.0
0.5,200.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert len(points) == 2
            assert points[1] == (0.5, 200.0)
        finally:
            Path(csv_path).unlink()

    def test_comment_lines_ignored(self):
        csv_content = """# This is a comment
time,thrust
// Another comment
0.0,0.0
0.1,100.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert len(points) == 2
        finally:
            Path(csv_path).unlink()

    def test_extra_columns_ignored(self):
        csv_content = """time,thrust,temperature,pressure
0.0,0.0,25.0,101.3
0.1,100.0,30.0,102.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert len(points) == 2
            assert points[0] == (0.0, 0.0)
            assert points[1] == (0.1, 100.0)
        finally:
            Path(csv_path).unlink()

    def test_metadata_extraction(self):
        csv_content = """time,thrust,engine_name,diameter_mm,length_mm,manufacturer
0.0,0.0,K500,38,200,TestCo
0.1,500.0,,,,,
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert metadata.name == "K500"
            assert metadata.diameter_mm == 38.0
            assert metadata.length_mm == 200.0
            assert metadata.manufacturer == "TestCo"
        finally:
            Path(csv_path).unlink()

    def test_milliseconds_conversion(self):
        csv_content = """time_ms,thrust
0,0.0
100,100.0
200,0.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert points[0] == (0.0, 0.0)
            assert points[1] == (0.1, 100.0)  # 100ms = 0.1s
            assert points[2] == (0.2, 0.0)
        finally:
            Path(csv_path).unlink()

    def test_lbf_conversion(self):
        csv_content = """time,thrust_lbf
0.0,0.0
0.1,10.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            expected_thrust_n = 10.0 * LBF_TO_N
            assert abs(points[1][1] - expected_thrust_n) < 0.01
        finally:
            Path(csv_path).unlink()

    def test_explicit_unit_override(self):
        csv_content = """time,thrust
0,0.0
100,22.5
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            # Force ms and lbf interpretation
            metadata, points = read_csv_curve(csv_path, time_units="ms", thrust_units="lbf")
            assert points[1][0] == 0.1  # 100ms -> 0.1s
            expected_thrust = 22.5 * LBF_TO_N
            assert abs(points[1][1] - expected_thrust) < 0.01
        finally:
            Path(csv_path).unlink()

    def test_negative_thrust_clamped(self):
        csv_content = """time,thrust
0.0,-5.0
0.1,100.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert points[0][1] == 0.0  # Negative clamped to 0
        finally:
            Path(csv_path).unlink()

    def test_negative_time_raises_error(self):
        csv_content = """time,thrust
-0.1,0.0
0.0,100.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            with pytest.raises(ValueError, match="Negative time"):
                read_csv_curve(csv_path)
        finally:
            Path(csv_path).unlink()

    def test_no_header_assumes_time_thrust(self):
        # First two columns are numeric - no header detected
        csv_content = """0.0,0.0
0.1,100.0
0.2,50.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert len(points) == 3
            assert points[1] == (0.1, 100.0)
        finally:
            Path(csv_path).unlink()

    def test_whitespace_handling(self):
        csv_content = """  time  ,  thrust  
  0.0  ,  0.0  
  0.1  ,  100.0  
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        try:
            metadata, points = read_csv_curve(csv_path)
            assert len(points) == 2
        finally:
            Path(csv_path).unlink()


class TestNormalizeCurve:
    """Tests for normalize_curve function."""

    def test_already_normalized(self):
        """Curve already starts at 0 and ends at 0."""
        points = [(0.0, 0.0), (0.1, 100.0), (0.2, 0.0)]
        normalized = normalize_curve(points)
        assert normalized == [(0.0, 0.0), (0.1, 100.0), (0.2, 0.0)]

    def test_insert_zero_start(self):
        """Insert t=0 if curve doesn't start there."""
        points = [(0.05, 100.0), (0.1, 150.0), (0.2, 0.0)]
        normalized = normalize_curve(points)
        assert normalized[0] == (0.0, 0.0)
        assert normalized[1] == (0.05, 100.0)

    def test_append_zero_end(self):
        """Append thrust=0 at end if curve doesn't end at 0."""
        points = [(0.0, 0.0), (0.1, 100.0), (0.2, 50.0)]
        normalized = normalize_curve(points)
        assert normalized[-1][1] == 0.0
        assert normalized[-1][0] > 0.2  # Slightly after last point

    def test_sorting(self):
        """Unsorted points should be sorted by time."""
        points = [(0.2, 50.0), (0.0, 0.0), (0.1, 100.0), (0.15, 120.0)]
        normalized = normalize_curve(points)
        times = [p[0] for p in normalized]
        assert times == sorted(times)

    def test_duplicate_times_kept_last(self):
        """Duplicate times should keep the last value."""
        points = [(0.0, 0.0), (0.1, 100.0), (0.1, 150.0), (0.2, 0.0)]
        normalized = normalize_curve(points)
        # Should have t=0.1 with value 150.0 (last one)
        t_01_point = [p for p in normalized if p[0] == 0.1][0]
        assert t_01_point[1] == 150.0

    def test_rounding(self):
        """Values should be rounded appropriately."""
        points = [(0.0, 0.0), (0.12345, 100.5678)]
        normalized = normalize_curve(points, time_decimals=3, thrust_decimals=1)

        # Find the point at ~0.123
        mid_point = [p for p in normalized if 0.12 < p[0] < 0.13][0]
        assert mid_point[0] == 0.123
        assert mid_point[1] == 100.6

    def test_empty_input(self):
        """Empty input should return minimal valid curve."""
        normalized = normalize_curve([])
        assert normalized == [(0.0, 0.0)]


class TestWriteEng:
    """Tests for write_eng function."""

    def test_basic_output(self):
        metadata = EngineMetadata(
            name="TestMotor",
            diameter_mm=29,
            length_mm=124,
            delays="5",
            prop_mass_kg=0.05,
            total_mass_kg=0.1,
            manufacturer="TestMfr",
        )
        points = [(0.0, 0.0), (0.1, 100.0), (0.2, 0.0)]

        with tempfile.NamedTemporaryFile(mode="w", suffix=".eng", delete=False) as f:
            eng_path = f.name

        try:
            write_eng(eng_path, metadata, points)

            content = Path(eng_path).read_text()
            lines = content.strip().split("\n")

            # Check comment line
            assert lines[0].startswith(";")

            # Check header
            assert "TestMotor 29 124 5 0.0500 0.1000 TestMfr" in lines[1]

            # Check data lines
            assert "0.000 0.0" in lines[2]
            assert "0.100 100.0" in lines[3]
            assert "0.200 0.0" in lines[4]
        finally:
            Path(eng_path).unlink()


class TestConvert:
    """Tests for the high-level convert function."""

    def test_full_conversion(self):
        csv_content = """time,thrust
0.0,0.0
0.1,100.0
0.2,150.0
0.3,50.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        eng_path = csv_path.replace(".csv", ".eng")

        try:
            convert(
                csv_path,
                eng_path,
                name="TestEngine",
                diameter_mm=38,
                length_mm=200,
                manufacturer="PyTest",
            )

            content = Path(eng_path).read_text()
            assert "TestEngine" in content
            assert "38" in content
            assert "PyTest" in content

            # Should have appended thrust=0 at end
            lines = content.strip().split("\n")
            last_line = lines[-1]
            assert last_line.endswith(" 0.0")

        finally:
            Path(csv_path).unlink()
            if Path(eng_path).exists():
                Path(eng_path).unlink()

    def test_conversion_with_unit_override(self):
        # CSV with values in ms and lbf
        csv_content = """time,thrust
0,0.0
100,10.0
200,5.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        eng_path = csv_path.replace(".csv", ".eng")

        try:
            convert(
                csv_path,
                eng_path,
                time_units="ms",
                thrust_units="lbf",
            )

            content = Path(eng_path).read_text()
            lines = content.strip().split("\n")

            # Check time conversion (100ms -> 0.100s)
            assert "0.100" in lines[3]

            # Check thrust conversion (10 lbf -> ~44.5 N)
            data_line = lines[3]
            thrust_val = float(data_line.split()[1])
            expected = 10.0 * LBF_TO_N
            assert abs(thrust_val - expected) < 0.1

        finally:
            Path(csv_path).unlink()
            if Path(eng_path).exists():
                Path(eng_path).unlink()


class TestCLI:
    """Tests for CLI functionality."""

    def test_cli_basic(self):
        from csv_to_eng.cli import main

        csv_content = """time,thrust
0.0,0.0
0.1,100.0
0.2,0.0
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write(csv_content)
            csv_path = f.name

        eng_path = csv_path.replace(".csv", ".eng")

        try:
            exit_code = main([
                "--input", csv_path,
                "--output", eng_path,
                "--name", "CLITest",
            ])

            assert exit_code == 0
            assert Path(eng_path).exists()
            content = Path(eng_path).read_text()
            assert "CLITest" in content

        finally:
            Path(csv_path).unlink()
            if Path(eng_path).exists():
                Path(eng_path).unlink()

    def test_cli_missing_file(self):
        from csv_to_eng.cli import main

        exit_code = main([
            "--input", "/nonexistent/file.csv",
            "--output", "/tmp/output.eng",
        ])

        assert exit_code == 1  # Error exit code
