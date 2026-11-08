export interface AutoGainControlConfig {
  /** Opt-in digital microphone AGC after denoising. Default false. */
  enabled?: boolean;
  /** Maximum automatic boost, 0..30 dB. Default 12. */
  maxGainDb?: number;
  /** Output noise ceiling, -90..0 dBFS. Default -50. */
  maxOutputNoiseLevelDbfs?: number;
  /** Maximum change, greater than 0 and at most 60 dB/s. Default 3. */
  maxGainChangeDbPerSecond?: number;
  /** Headroom, 0..30 dB. Default 6. */
  headroomDb?: number;
  /** Output peak ceiling, -24..0 dBFS. Default -3. */
  peakLevelDbfs?: number;
}

export function validateGainDb(db: number): number {
  if (!Number.isFinite(db) || db < -60 || db > 12) throw new Error('invalid_audio_gain_db');
  return db;
}

/** Validates all settings before applying any, and gives explicit new AGC settings priority over the legacy alias. */
export function gainConfig(config: {
  micGainDb?: number; speakerGainDb?: number; autoGainControl?: AutoGainControlConfig; micAgc2Enabled?: boolean;
}): { micGainDb: number; speakerGainDb: number; autoGainControl: Required<AutoGainControlConfig> } {
  const micGainDb = validateGainDb(config.micGainDb === undefined ? 0 : config.micGainDb);
  const speakerGainDb = validateGainDb(config.speakerGainDb === undefined ? 0 : config.speakerGainDb);
  const supplied = config.autoGainControl;
  if (supplied !== undefined && (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied))) throw new Error('invalid_auto_gain_control');
  if (config.micAgc2Enabled !== undefined && typeof config.micAgc2Enabled !== 'boolean') throw new Error('invalid_auto_gain_control');
  if (supplied && Object.keys(supplied).some(key => !['enabled', 'maxGainDb', 'maxOutputNoiseLevelDbfs', 'maxGainChangeDbPerSecond', 'headroomDb', 'peakLevelDbfs'].includes(key))) throw new Error('invalid_auto_gain_control');
  const enabled = supplied === undefined ? (config.micAgc2Enabled ?? false) : (supplied.enabled === undefined ? false : supplied.enabled);
  if (typeof enabled !== 'boolean') throw new Error('invalid_auto_gain_control');
  const bounded = (value: number | undefined, fallback: number, min: number, max: number, exclusiveMin = false): number => {
    const db = value === undefined ? fallback : value;
    if (!Number.isFinite(db) || db < min || db > max || (exclusiveMin && db === min)) throw new Error('invalid_auto_gain_control');
    return db;
  };
  return { micGainDb, speakerGainDb, autoGainControl: {
    enabled,
    maxGainDb: bounded(supplied?.maxGainDb, 12, 0, 30),
    maxOutputNoiseLevelDbfs: bounded(supplied?.maxOutputNoiseLevelDbfs, -50, -90, 0),
    maxGainChangeDbPerSecond: bounded(supplied?.maxGainChangeDbPerSecond, 3, 0, 60, true),
    headroomDb: bounded(supplied?.headroomDb, 6, 0, 30),
    peakLevelDbfs: bounded(supplied?.peakLevelDbfs, -3, -24, 0),
  } };
}
