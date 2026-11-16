"""A small OpenRocket design, written by hand, that the importer tests share.

It is chosen to exercise each rule the importer implements -- every axial method
(top, bottom, middle, after, absolute), a bare ``auto`` radius on the airframe and
on rings, masses computed from materials (tubes, rings, canopy, cord, fins), a
mass override with a subtree, a CG override, a shouldered ogive nose, a conical
boattail and a motor mount -- so a mistake in one shows up as one number.

The same XML is opened by OpenRocket itself in ``test_ork_openrocket.py``.
"""

from __future__ import annotations

R = 0.05  # body radius
T = 0.002  # body wall
NOSE_L, UPPER_L, LOWER_L, TAIL_L = 0.6, 0.8, 1.0, 0.08


def sample_ork_xml(with_motor: bool = True) -> str:
    motor = (
        """
              <motormount>
                <ignitionevent>automatic</ignitionevent>
                <ignitiondelay>0.0</ignitiondelay>
                <overhang>0.02</overhang>
                <motor configid="cfg-1">
                  <type>reload</type>
                  <manufacturer>Cesaroni Technology</manufacturer>
                  <digest>0123456789abcdef0123456789abcdef</digest>
                  <designation>1395I205-14A</designation>
                  <diameter>0.054</diameter>
                  <length>0.404</length>
                  <delay>14.0</delay>
                </motor>
              </motormount>"""
        if with_motor
        else ""
    )
    config = '<motorconfiguration configid="cfg-1" default="true"><stage number="0" active="true"/></motorconfiguration>' if with_motor else ""
    return f"""<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12">
  <rocket>
    <name>Sample</name>
    <id>rocket</id>
    {config}
    <referencetype>maximum</referencetype>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <id>stage</id>
        <subcomponents>
          <nosecone>
            <name>Nose</name>
            <id>nose</id>
            <overridemass>0.8</overridemass>
            <overridesubcomponentsmass>false</overridesubcomponentsmass>
            <finish>smooth</finish>
            <material type="bulk" density="1850.0">Fiberglass</material>
            <length>{NOSE_L}</length>
            <thickness>0.003</thickness>
            <shape>ogive</shape>
            <shapeparameter>1.0</shapeparameter>
            <aftradius>{R}</aftradius>
            <aftshoulderradius>0.048</aftshoulderradius>
            <aftshoulderlength>0.08</aftshoulderlength>
            <aftshoulderthickness>0.003</aftshoulderthickness>
            <aftshouldercapped>false</aftshouldercapped>
            <subcomponents>
              <masscomponent>
                <name>Nose weight</name>
                <id>noseweight</id>
                <axialoffset method="top">0.1</axialoffset>
                <packedlength>0.05</packedlength>
                <packedradius>0.02</packedradius>
                <mass>0.3</mass>
              </masscomponent>
            </subcomponents>
          </nosecone>
          <bodytube>
            <name>Upper</name>
            <id>upper</id>
            <overridemass>2.0</overridemass>
            <overridesubcomponentsmass>true</overridesubcomponentsmass>
            <material type="bulk" density="1250.0">Phenolic</material>
            <length>{UPPER_L}</length>
            <thickness>{T}</thickness>
            <radius>auto</radius>
            <subcomponents>
              <parachute>
                <name>Main</name>
                <id>main</id>
                <axialoffset method="top">0.1</axialoffset>
                <packedlength>0.12</packedlength>
                <packedradius>0.04</packedradius>
                <cd>1.5</cd>
                <material type="surface" density="0.067">Ripstop nylon</material>
                <diameter>1.2</diameter>
                <linecount>8</linecount>
                <linelength>1.0</linelength>
                <linematerial type="line" density="0.0023">Elastic cord</linematerial>
              </parachute>
              <shockcord>
                <name>Cord</name>
                <id>cord</id>
                <axialoffset method="after">0.0</axialoffset>
                <packedlength>0.05</packedlength>
                <packedradius>0.03</packedradius>
                <cordlength>5.0</cordlength>
                <material type="line" density="0.02">Tubular nylon</material>
              </shockcord>
              <bulkhead>
                <name>Upper bulkhead</name>
                <id>upperbulk</id>
                <axialoffset method="bottom">0.0</axialoffset>
                <material type="bulk" density="680.0">Plywood</material>
                <length>0.01</length>
                <outerradius>auto</outerradius>
              </bulkhead>
            </subcomponents>
          </bodytube>
          <bodytube>
            <name>Lower</name>
            <id>lower</id>
            <material type="bulk" density="1250.0">Phenolic</material>
            <length>{LOWER_L}</length>
            <thickness>{T}</thickness>
            <radius>{R}</radius>
            <subcomponents>
              <innertube>
                <name>Motor tube</name>
                <id>mmt</id>
                <axialoffset method="bottom">0.0</axialoffset>
                <material type="bulk" density="1250.0">Phenolic</material>
                <length>0.4</length>
                <outerradius>0.0275</outerradius>
                <thickness>0.0015</thickness>
                <clusterconfiguration>single</clusterconfiguration>{motor}
              </innertube>
              <centeringring>
                <name>Fwd ring</name>
                <id>ring1</id>
                <axialoffset method="top">0.62</axialoffset>
                <material type="bulk" density="680.0">Plywood</material>
                <length>0.006</length>
                <outerradius>auto</outerradius>
                <innerradius>auto</innerradius>
              </centeringring>
              <centeringring>
                <name>Aft ring</name>
                <id>ring2</id>
                <axialoffset method="bottom">-0.05</axialoffset>
                <material type="bulk" density="680.0">Plywood</material>
                <length>0.006</length>
                <outerradius>auto</outerradius>
                <innerradius>auto</innerradius>
              </centeringring>
              <masscomponent>
                <name>Avionics</name>
                <id>avionics</id>
                <axialoffset method="middle">-0.2</axialoffset>
                <packedlength>0.1</packedlength>
                <packedradius>0.04</packedradius>
                <mass>0.5</mass>
                <overridecg>0.02</overridecg>
              </masscomponent>
              <masscomponent>
                <name>Tracker</name>
                <id>tracker</id>
                <axialoffset method="absolute">1.5</axialoffset>
                <packedlength>0.04</packedlength>
                <packedradius>0.02</packedradius>
                <mass>0.1</mass>
              </masscomponent>
              <trapezoidfinset>
                <name>Fins</name>
                <id>fins</id>
                <axialoffset method="bottom">0.0</axialoffset>
                <material type="bulk" density="680.0">Plywood</material>
                <fincount>3</fincount>
                <rotation>0.0</rotation>
                <angleoffset method="relative">0.0</angleoffset>
                <thickness>0.004</thickness>
                <crosssection>square</crosssection>
                <cant>0.0</cant>
                <filletradius>0.0</filletradius>
                <rootchord>0.2</rootchord>
                <tipchord>0.08</tipchord>
                <sweeplength>0.12</sweeplength>
                <height>0.1</height>
              </trapezoidfinset>
            </subcomponents>
          </bodytube>
          <transition>
            <name>Tail</name>
            <id>tail</id>
            <material type="bulk" density="1250.0">Phenolic</material>
            <length>{TAIL_L}</length>
            <thickness>{T}</thickness>
            <shape>conical</shape>
            <foreradius>auto</foreradius>
            <aftradius>0.035</aftradius>
          </transition>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>
</openrocket>
"""
