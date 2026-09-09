import type { NodeTypes } from '@xyflow/react';
import { SensorNode }      from './SensorNode';
import { ValveNode }       from './ValveNode';
import { CheckValveNode }  from './CheckValveNode';
import { PRNode }          from './PRNode';
import { RVNode }          from './RVNode';
import { QDNode }          from './QDNode';
import { TankNode }        from './TankNode';
import { TextNode }        from './TextNode';
import { JunctionNode }    from './JunctionNode';
import { EngineNode }      from './EngineNode';
import { ManifoldNode }    from './ManifoldNode';

export const nodeTypes: NodeTypes = {
  RTD:      SensorNode,
  PT:       SensorNode,
  PG:       SensorNode,
  LC:       SensorNode,
  TC:       SensorNode,
  MAN:      ValveNode,
  ROT:      ValveNode,
  SOL:      ValveNode,
  PR:       PRNode,
  RV:       RVNode,
  CV:       CheckValveNode,
  QD:       QDNode,
  TANK:     TankNode,
  INJECTOR: TankNode,
  ENGINE:   EngineNode,
  MANIFOLD: ManifoldNode,
  TEXT:     TextNode,
  JUNCTION: JunctionNode,
};
