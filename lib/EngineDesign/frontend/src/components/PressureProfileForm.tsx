import { useState, useEffect } from 'react';
import type { ProfileParams, ProfileType } from '../api/client';

interface PressureProfileFormProps {
  duration: number;
  nSteps: number;
  loxProfile: ProfileParams;
  fuelProfile: ProfileParams;
  onDurationChange: (value: number) => void;
  onNStepsChange: (value: number) => void;
  onLoxProfileChange: (profile: ProfileParams) => void;
  onFuelProfileChange: (profile: ProfileParams) => void;
  onSubmit: () => void;
  isLoading: boolean;
}

interface ProfileInputProps {
  label: string;
  profile: ProfileParams;
  onChange: (profile: ProfileParams) => void;
  colorClass: string;
}

function ProfileInput({ label, profile, onChange, colorClass }: ProfileInputProps) {
  const profileTypes: ProfileType[] = ['linear', 'exponential', 'power'];
  
  const [startPressureInput, setStartPressureInput] = useState(profile.start_pressure_psi.toString());
  const [endPressureInput, setEndPressureInput] = useState(profile.end_pressure_psi.toString());
  const [decayInput, setDecayInput] = useState((profile.decay_constant || 3.0).toString());
  const [powerInput, setPowerInput] = useState((profile.power || 2.0).toString());

  // Sync local state when profile changes externally
  useEffect(() => {
    setStartPressureInput(profile.start_pressure_psi.toString());
    setEndPressureInput(profile.end_pressure_psi.toString());
    setDecayInput((profile.decay_constant || 3.0).toString());
    setPowerInput((profile.power || 2.0).toString());
  }, [profile]);

  const commitStartPressure = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) {
      setStartPressureInput(profile.start_pressure_psi.toString());
      return;
    }
    onChange({ ...profile, start_pressure_psi: num });
    setStartPressureInput(num.toString());
  };

  const commitEndPressure = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) {
      setEndPressureInput(profile.end_pressure_psi.toString());
      return;
    }
    onChange({ ...profile, end_pressure_psi: num });
    setEndPressureInput(num.toString());
  };

  const commitDecay = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0.1 || num > 10) {
      setDecayInput((profile.decay_constant || 3.0).toString());
      return;
    }
    onChange({ ...profile, decay_constant: num });
    setDecayInput(num.toString());
  };

  const commitPower = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0.1 || num > 5) {
      setPowerInput((profile.power || 2.0).toString());
      return;
    }
    onChange({ ...profile, power: num });
    setPowerInput(num.toString());
  };

  return (
    <div className={`p-4 rounded-xl border ${colorClass}`}>
      <h4 className="text-sm font-semibold mb-3 text-[var(--color-text-primary)]">{label}</h4>
      
      <div className="grid grid-cols-2 gap-3">
        {/* Start Pressure */}
        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Start Pressure
          </label>
          <div className="relative">
            <input
              type="text"
              value={startPressureInput}
              onChange={(e) => setStartPressureInput(e.target.value)}
              onBlur={(e) => commitStartPressure(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-full px-3 py-2 pr-10 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-blue-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-secondary)]">psi</span>
          </div>
        </div>

        {/* End Pressure */}
        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            End Pressure
          </label>
          <div className="relative">
            <input
              type="text"
              value={endPressureInput}
              onChange={(e) => setEndPressureInput(e.target.value)}
              onBlur={(e) => commitEndPressure(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-full px-3 py-2 pr-10 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-blue-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-secondary)]">psi</span>
          </div>
        </div>

        {/* Profile Type */}
        <div className="col-span-2">
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
            Profile Type
          </label>
          <select
            value={profile.profile_type}
            onChange={(e) => onChange({ ...profile, profile_type: e.target.value as ProfileType })}
            className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-blue-500"
          >
            {profileTypes.map(type => (
              <option key={type} value={type}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* Decay Constant (for exponential) */}
        {profile.profile_type === 'exponential' && (
          <div className="col-span-2">
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
              Decay Constant
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0.1"
                max="10"
                step="0.1"
                value={profile.decay_constant || 3.0}
                onChange={(e) => onChange({ ...profile, decay_constant: parseFloat(e.target.value) })}
                className="flex-1 accent-blue-500"
              />
              <input
                type="text"
                value={decayInput}
                onChange={(e) => setDecayInput(e.target.value)}
                onBlur={(e) => commitDecay(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className="w-16 px-2 py-1 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex justify-between text-xs text-[var(--color-text-secondary)] mt-1">
              <span>0.1 (gradual)</span>
              <span>10 (rapid)</span>
            </div>
          </div>
        )}

        {/* Power (for power profile) */}
        {profile.profile_type === 'power' && (
          <div className="col-span-2">
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
              Power Exponent
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0.1"
                max="5"
                step="0.1"
                value={profile.power || 2.0}
                onChange={(e) => onChange({ ...profile, power: parseFloat(e.target.value) })}
                className="flex-1 accent-blue-500"
              />
              <input
                type="text"
                value={powerInput}
                onChange={(e) => setPowerInput(e.target.value)}
                onBlur={(e) => commitPower(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className="w-16 px-2 py-1 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex justify-between text-xs text-[var(--color-text-secondary)] mt-1">
              <span>0.1 (concave)</span>
              <span>5 (convex)</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PressureProfileForm({
  duration,
  nSteps,
  loxProfile,
  fuelProfile,
  onDurationChange,
  onNStepsChange,
  onLoxProfileChange,
  onFuelProfileChange,
  onSubmit,
  isLoading,
}: PressureProfileFormProps) {
  const [durationInput, setDurationInput] = useState(duration.toString());
  const [nStepsInput, setNStepsInput] = useState(nSteps.toString());

  useEffect(() => {
    setDurationInput(duration.toString());
  }, [duration]);

  useEffect(() => {
    setNStepsInput(nSteps.toString());
  }, [nSteps]);

  const commitDuration = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0.1 || num > 600) {
      setDurationInput(duration.toString());
      return;
    }
    onDurationChange(num);
    setDurationInput(num.toString());
  };

  const commitNSteps = (value: string) => {
    const num = parseInt(value);
    if (isNaN(num) || num < 2 || num > 2000) {
      setNStepsInput(nSteps.toString());
      return;
    }
    onNStepsChange(num);
    setNStepsInput(num.toString());
  };

  return (
    <div className="space-y-4">
      {/* Duration and Samples */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
            Duration
          </label>
          <div className="relative">
            <input
              type="text"
              value={durationInput}
              onChange={(e) => setDurationInput(e.target.value)}
              onBlur={(e) => commitDuration(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-full px-4 py-3 pr-8 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-secondary)]">s</span>
          </div>
        </div>

        <div>
          <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
            Samples
          </label>
          <input
            type="text"
            value={nStepsInput}
            onChange={(e) => setNStepsInput(e.target.value)}
            onBlur={(e) => commitNSteps(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* LOX Profile */}
      <ProfileInput
        label="LOX Pressure Profile"
        profile={loxProfile}
        onChange={onLoxProfileChange}
        colorClass="border-cyan-500/30 bg-cyan-500/5"
      />

      {/* Fuel Profile */}
      <ProfileInput
        label="Fuel Pressure Profile"
        profile={fuelProfile}
        onChange={onFuelProfileChange}
        colorClass="border-orange-500/30 bg-orange-500/5"
      />

      {/* Submit Button */}
      <button
        onClick={onSubmit}
        disabled={isLoading}
        className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Running Time-Series...
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Run Time-Series
          </>
        )}
      </button>
    </div>
  );
}

