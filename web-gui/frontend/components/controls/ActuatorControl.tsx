'use client'

import React from 'react';
import { ActuatorId } from '@/lib/types';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import ActuatorControlByName from './ActuatorControlByName';

interface ActuatorControlProps {
  actuatorId: ActuatorId;
}

export default function ActuatorControl({ actuatorId }: ActuatorControlProps) {
  const { actuators, loading } = useActuatorsFromConfig();
  const actuator = actuators[actuatorId];

  if (!actuator) {
    return (
      <div className="rounded border border-gray-700 h-full min-h-0 flex items-center justify-center p-1 bg-background">
        <span className="text-[9px] text-gray-500">{loading ? 'Loading actuator...' : `Actuator ${actuatorId} missing in config`}</span>
      </div>
    );
  }

  return (
    <ActuatorControlByName
      name={actuator.name}
      channel={actuator.channel}
      entity={actuator.entity}
      boardId={actuator.boardId}
    />
  );
}
