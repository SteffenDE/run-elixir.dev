// The playground runtime's modules (src/runtime), plain JavaScript.
declare module '@runtime/bridge.js' {
  import type { Node } from '@runtime/host';
  export class Bridge {
    constructor(node: Pick<Node, 'connect'>, port?: number);
    port: number;
    static register(url?: string, scope?: string, key?: string): Promise<void>;
    static announce(message: { kind: 'host' | 'preview'; key: string }): Promise<void>;
  }
}
