"""The golden tests can fail: perturb one formula of the port and the comparison with
OpenRocket must report mismatches ("a test that cannot fail is not a test").

Each case breaks one thing slightly -- far below what a plot would show -- and asserts
that tests/_orweb_check.py notices on rockets that exercise it.
"""

from __future__ import annotations

import pytest

import orweb.components.internal as internal
import orweb.components.symmetric as symmetric
import orweb.config as config
import orweb.masscalc as masscalc
from _orweb_check import HERE, all_mismatches
from orweb.components import fins
from orweb.components.position import AxialMethod
from orweb.util.coordinate import Coordinate

EXAMPLES = HERE / "rockets"
GOLDEN = HERE / "golden"


def mismatches(name: str):
    return all_mismatches(EXAMPLES / f"{name}.ork", GOLDEN / f"{name}.json")


def test_unperturbed_is_clean():
    assert mismatches("A simple model rocket") == []


def test_ring_mass_one_part_in_ten_million(monkeypatch):
    real = internal.ring_mass
    monkeypatch.setattr(internal, "ring_mass", lambda *a: real(*a) * (1 + 1e-7))
    assert mismatches("A simple model rocket")


def test_frustum_integration_divisions(monkeypatch):
    monkeypatch.setattr(symmetric, "DIVISIONS", 127)
    assert mismatches("A simple model rocket")


def test_parallel_axis_theorem(monkeypatch):
    def rebase(self, new):
        d = self.cm.sub(new)
        w = self.cm.weight
        return masscalc.RigidBody(new, self.Ixx + w * (d.y * d.y + d.z * d.z), self.Iyy + w * d.x * d.x,
                                  self.Izz + w * (d.x * d.x + d.y * d.y))  # drops z^2 from Iyy
    monkeypatch.setattr(masscalc.RigidBody, "rebase", rebase)
    assert mismatches("Pods--airframes and winglets")


def test_middle_positioning(monkeypatch):
    real = AxialMethod.get_as_position

    def pos(self, offset, inner, outer):
        if self is AxialMethod.MIDDLE:
            return offset + (outer - inner) / 2 + 1e-6
        return real(self, offset, inner, outer)
    monkeypatch.setattr(AxialMethod, "get_as_position", pos)
    assert mismatches("A simple model rocket")


def test_fin_planform_centroid(monkeypatch):
    real = fins.calculate_curve_integral
    monkeypatch.setattr(fins, "calculate_curve_integral",
                        lambda pts: (lambda c: Coordinate(c.x * (1 + 1e-8), c.y, c.z, c.weight))(real(pts)))
    assert mismatches("A simple model rocket")


def test_ogive_shape(monkeypatch):
    real = symmetric.Shape.get_radius

    def radius(self, x, r, length, param):
        if self is symmetric.Shape.OGIVE:
            param = param * (1 - 1e-6)
        return real(self, x, r, length, param)
    monkeypatch.setattr(symmetric.Shape, "get_radius", radius)
    assert mismatches("A simple model rocket")


def test_motor_overhang(monkeypatch):
    monkeypatch.setattr(config.MotorConfiguration, "get_x",
                        lambda self: self.mount.get_length() - self.motor.get_length())
    assert mismatches("A simple model rocket")


def test_cluster_geometry(monkeypatch):
    monkeypatch.setattr(internal.InnerTube, "get_cluster_separation",
                        lambda self: 2 * self.get_outer_radius() * self.cluster_scale * (1 + 1e-7))
    assert mismatches("Clustered motors")


@pytest.mark.parametrize("name", ["Pods--powered with recovery deployment", "Parallel booster staging"])
def test_assembly_instances(monkeypatch, name):
    import orweb.components.assemblies as asm
    real = asm.PodSet.get_instance_angles
    monkeypatch.setattr(asm.PodSet, "get_instance_angles", lambda self: [a + 1e-6 for a in real(self)])
    real2 = asm.ParallelStage.get_instance_angles
    monkeypatch.setattr(asm.ParallelStage, "get_instance_angles", lambda self: [a + 1e-6 for a in real2(self)])
    assert mismatches(name)
