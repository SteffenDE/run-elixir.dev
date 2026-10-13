// The playground runtime's modules (playground/runtime), plain JavaScript.
declare module '@runtime/host.js' {
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
  // The shared filesystem's operations (files.js through host.js Files).
  export interface FileSystem {
    list(path: string, skip?: string[]): Promise<Entry[]>;
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(path: string, to: string): Promise<void>;
  }
  export class Files implements FileSystem {
    constructor(options?: {
      base?: string;
      boots?: string[];
      template?: string[];
      onchange?: (paths: string[]) => void;
    });
    ready: Promise<void>;
    list(path: string, skip?: string[]): Promise<Entry[]>;
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(path: string, to: string): Promise<void>;
  }
  export interface PageProcess {
    write(data: string | Uint8Array): void;
    exit(code?: number): void;
    onkill: (() => void) | null;
  }
  export class Node {
    constructor(options: {
      base?: string;
      files?: Files;
      onoutput?: (bytes: Uint8Array) => void;
      onstatus?: (text: string) => void;
      onexit?: (code: number) => void;
      onlistening?: (port: number, on: boolean) => void;
      serve?: Record<number, (connection: Connection) => void>;
      programs?: Record<
        string,
        (
          process: PageProcess,
          context: { args: string[]; cwd: string; env: Record<string, string>; fs: FileSystem },
        ) => void | Promise<void>
      >;
    });
    worker: Worker;
    readonly fs: FileSystem;
    readonly listening: Set<number>;
    start(options: {
      shell?: boolean;
      args?: string[];
      env?: Record<string, string>;
      initial?: string[];
      cwd?: string;
      boots?: string[];
    }): void;
    stop(): void;
    input(text: string): void;
    interrupt(): void;
    connect(port: number): Connection;
  }
}
declare module '@runtime/bridge.js' {
  import type { Node } from '*/runtime/host.js';
  export class Bridge {
    constructor(node: Pick<Node, 'connect'>, port?: number);
    static register(url?: string): Promise<void>;
  }
}
declare module '@runtime/postgres.js' {
  import type { Connection } from '*/runtime/host.js';
  export function postgres(db: unknown): (connection: Connection) => void;
}
declare module '@runtime/terminal.js' {
  export function cooked(
    term: { write(data: string): void; onData(listener: (data: string) => void): unknown },
    node: { input(text: string): void; interrupt(): void },
  ): void;
}
