/**
 * Download task lifecycle states.
 * Mirrors FluxDown's state machine: queued -> downloading -> (paused | completed | error) -> verifying.
 */
export enum TaskStatus {
  Pending = 'pending',
  Queued = 'queued',
  Downloading = 'downloading',
  Paused = 'paused',
  Verifying = 'verifying',
  Completed = 'completed',
  Error = 'error'
}
