// A threaded node's thread in a Web Worker: host.ts starts it when
// worker.js asks (threads.ts).
import { runThread } from './threads';

onmessage = ({ data }) => runThread(data);
