/**
 * Download task lifecycle states.
 * Mirrors FluxDown Cover's state machine: queued -> downloading -> (paused | completed | error) -> verifying.
 * Merging is the HLS/DASH intermediate phase after all segments are assembled
 * and before integrity verification.
 */
export enum TaskStatus {
  Pending = 'pending',
  Queued = 'queued',
  Downloading = 'downloading',
  Paused = 'paused',
  Merging = 'merging',
  Verifying = 'verifying',
  Completed = 'completed',
  Error = 'error'
}
