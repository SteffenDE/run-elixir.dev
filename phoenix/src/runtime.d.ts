// The playground runtime's modules (playground/runtime), plain JavaScript.
declare module '*/runtime/host.js' {
  export interface Connection {
    ondata: (bytes: Uint8Array) => void;
    onend: () => void;
    onclose: (why?: string) => void;
    write(bytes: Uint8Array): void;
    end(): void;
    close(): void;
  }
  export interface Entry {
    path: string;
    dir: boolean;
  }
  export interface Files {
    list(path: string, skip?: string[]): Promise<Entry[]>;
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(path: string, to: string): Promise<void>;
  }
  export class Node {
    constructor(options: {
      base?: string;
      onoutput?: (bytes: Uint8Array) => void;
      onstatus?: (text: string) => void;
      onexit?: (code: number) => void;
      onchange?: (paths: string[]) => void;
      serve?: Record<number, (connection: Connection) => void>;
    });
    worker: Worker;
    readonly fs: Files;
    start(options: {
      shell?: boolean;
      args?: string[];
      env?: Record<string, string>;
      initial?: string[];
    }): void;
    input(text: string): void;
    interrupt(): void;
    connect(port: number): Connection;
  }
}
declare module '*/runtime/bridge.js' {
  import type { Node } from '*/runtime/host.js';
  export class Bridge {
    constructor(node: Node, port?: number);
    static register(url?: string): Promise<void>;
  }
}
declare module '*/runtime/postgres.js' {
  import type { Connection } from '*/runtime/host.js';
  export function postgres(db: unknown): (connection: Connection) => void;
}
declare module '*/runtime/terminal.js' {
  export function cooked(
    term: { write(data: string): void; onData(listener: (data: string) => void): unknown },
    node: { input(text: string): void; interrupt(): void },
  ): void;
}
