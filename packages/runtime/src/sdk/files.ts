// The packages' surface: a worker program's channel to the project's
// files (the workers seam: start's doorbell and channel), which its
// process and its threads share, one call at a time by the process's lock.
export {
  lockBusyUnder,
  lockFree,
  lockStop,
  lockThread,
  processLock,
  sharedClient,
  type SharedCall,
} from '../wasi/shared';
