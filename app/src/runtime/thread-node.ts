// A threaded node's thread under Node (node.ts starts it).
import { workerData } from 'node:worker_threads';
import { runThread } from './threads';

runThread(workerData);
