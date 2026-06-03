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
  TEXT:     TextNode,
  JUNCTION: JunctionNode,
};
