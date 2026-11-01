// The packages' surface: a package's shared frame (the frames seam). Its
// page calls serveFrame and takes a port for each of its programs' asks.
// rpc: calls and events over such a port, whose messages are the
// package's own.
export { FRAME_LOADED, FRAME_PORT, serveFrame, type FrameContext } from '../lib/sharedFrame';
export { Rpc, transfer, Transfer } from '../lib/rpc';
