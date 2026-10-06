/**
 * Convert a quarter-note BPM value to the duration of the selected beat unit.
 *
 * @param {number} bpm
 * @param {number} beatUnit
 * @returns {number} Seconds between metronome clicks.
 */
export function secondsPerBeat(bpm, beatUnit) {
  return (60 / bpm) * (4 / beatUnit);
}
