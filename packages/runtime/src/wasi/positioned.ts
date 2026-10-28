import { E, type Local, type Preview1 } from './abi';
import { File } from './fs';
import type { WASI } from './index';

// Reads and writes at an offset (pread, pwrite) and the position
// (fd_tell), on top of `io`'s fd_read and fd_write, so local and shared
// files take them alike: the descriptor's position is set for the call
// and kept (a write at an offset does not append). Streams, ports and
// the like have no position (ESPIPE).
export function positioned(
  wasi: WASI,
  io: Local,
): Pick<Preview1, 'fd_pread' | 'fd_pwrite' | 'fd_tell'> {
  const holder = (fd: number) => {
    const entry = wasi.fds.get(fd);
    if (!entry) return E.BADF;
    const file = entry.remote ?? (entry.node instanceof File ? entry : null);
    return file && !entry.nif ? file : E.SPIPE;
  };
  const at = (fd: number, offset: bigint, run: () => number) => {
    const file = holder(fd);
    if (typeof file === 'number') return file;
    const [position, append] = [file.position, file.append];
    Object.assign(file, { position: Number(offset), append: false });
    try {
      return run();
    } finally {
      Object.assign(file, { position, append });
    }
  };
  return {
    fd_pread: (fd, iovs, count, offset, ptr) =>
      at(fd, offset, () => io.fd_read(fd, iovs, count, ptr)),
    fd_pwrite: (fd, iovs, count, offset, ptr) =>
      at(fd, offset, () => io.fd_write(fd, iovs, count, ptr)),
    fd_tell(fd, ptr) {
      const file = holder(fd);
      if (typeof file === 'number') return file;
      wasi.view().setBigUint64(ptr, BigInt(file.position!), true);
      return E.SUCCESS;
    },
  };
}
