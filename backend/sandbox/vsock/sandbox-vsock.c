// sandbox-vsock connects a sandbox VM to its host over vsock, for VMMs without
// virtio-serial ports, such as Firecracker. It runs as root in the guest, and
// returns once everything is connected, leaving processes behind that copy the
// data.
//
//   sandbox-vsock channels <dir> <name>:<port>:<in|out|both>...
//
// Connects to each port on the host and makes it a FIFO in <dir> that only root
// can open, so that the guest init and the programs it starts can open a channel
// by path. An "out" channel carries what is written to <dir>/<name> to the host,
// an "in" channel what the host sends to it. A "both" channel is <name>.in and
// <name>.out.
//
//   sandbox-vsock net <port> <interface>
//
// Creates a TAP interface and exchanges its Ethernet frames with the host over
// <port>, each prefixed with its length as a big-endian uint32, like QEMU's
// stream netdev does.
//
// The host only accepts one connection per port, so a job, which could connect
// to any port, can't take over one that is already connected.

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_tun.h>
#include <linux/vm_sockets.h>
#include <net/if.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#define BUFFER_SIZE 65536
#define MAX_FRAME 65536

static void fail(const char *what) {
  fprintf(stderr, "sandbox-vsock: %s: %s\n", what, strerror(errno));
  exit(1);
}

static void usage(void) {
  fprintf(stderr,
          "usage: sandbox-vsock channels <dir> <name>:<port>:<in|out|both>...\n"
          "       sandbox-vsock net <port> <interface>\n");
  exit(2);
}

static unsigned int parse_port(const char *value) {
  char *end;
  unsigned long port = strtoul(value, &end, 10);

  if (*value == '\0' || *end != '\0' || port == 0 || port > UINT32_MAX - 1) {
    usage();
  }

  return (unsigned int)port;
}

static int connect_host(unsigned int port) {
  struct sockaddr_vm address = {
      .svm_family = AF_VSOCK,
      .svm_cid = VMADDR_CID_HOST,
      .svm_port = port,
  };

  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) fail("socket");

  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
    fprintf(stderr, "sandbox-vsock: connect to port %u: %s\n", port, strerror(errno));
    exit(1);
  }

  return fd;
}

static int write_all(int fd, const void *data, size_t size) {
  const char *position = data;

  while (size > 0) {
    ssize_t written = write(fd, position, size);

    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }

    position += written;
    size -= (size_t)written;
  }

  return 0;
}

// Returns 0 on success, -1 on an error or when the input ends early.
static int read_all(int fd, void *data, size_t size) {
  char *position = data;

  while (size > 0) {
    ssize_t count = read(fd, position, size);

    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;

    position += count;
    size -= (size_t)count;
  }

  return 0;
}

static void copy(int from, int to) {
  static char buffer[BUFFER_SIZE];

  for (;;) {
    ssize_t count = read(from, buffer, sizeof(buffer));

    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || write_all(to, buffer, (size_t)count) < 0) return;
  }
}

// Returns true in the child, which is meant to copy data and then _exit.
static int child(void) {
  pid_t pid = fork();
  if (pid < 0) fail("fork");
  return pid == 0;
}

static void make_fifo(const char *path) {
  if (mkfifo(path, 0600) < 0) fail(path);
}

// Opening a FIFO for both reading and writing doesn't wait for a writer, and
// never reports the end of input, as there always is one.
static void to_host(int socket_fd, const char *path) {
  make_fifo(path);

  if (child()) {
    int fd = open(path, O_RDWR);
    if (fd < 0) fail(path);
    copy(fd, socket_fd);
    _exit(0);
  }
}

// Only the child writes, so the reader sees the end of input once the host
// closes its end.
static void from_host(int socket_fd, const char *path) {
  make_fifo(path);

  if (child()) {
    int fd = open(path, O_WRONLY);
    if (fd < 0) fail(path);
    copy(socket_fd, fd);
    _exit(0);
  }
}

static int channels(int argc, char **argv) {
  if (argc < 4) usage();

  const char *dir = argv[2];

  for (int i = 3; i < argc; i++) {
    char *spec = argv[i];
    char *name = strsep(&spec, ":");
    char *port = strsep(&spec, ":");
    char *direction = spec;

    if (*name == '\0' || strchr(name, '/') || port == NULL || direction == NULL) usage();

    char path[4096], in_path[4096], out_path[4096];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    snprintf(in_path, sizeof(in_path), "%s/%s.in", dir, name);
    snprintf(out_path, sizeof(out_path), "%s/%s.out", dir, name);

    int fd = connect_host(parse_port(port));

    if (strcmp(direction, "out") == 0) {
      to_host(fd, path);
    } else if (strcmp(direction, "in") == 0) {
      from_host(fd, path);
    } else if (strcmp(direction, "both") == 0) {
      from_host(fd, in_path);
      to_host(fd, out_path);
    } else {
      usage();
    }

    close(fd);
  }

  return 0;
}

static void frames_to_host(int tap_fd, int socket_fd) {
  static char buffer[4 + MAX_FRAME];

  for (;;) {
    ssize_t size = read(tap_fd, buffer + 4, MAX_FRAME);

    if (size < 0 && errno == EINTR) continue;
    if (size <= 0) return;

    uint32_t length = htonl((uint32_t)size);
    memcpy(buffer, &length, 4);

    if (write_all(socket_fd, buffer, 4 + (size_t)size) < 0) return;
  }
}

static void frames_from_host(int socket_fd, int tap_fd) {
  static char frame[MAX_FRAME];

  for (;;) {
    uint32_t length;

    if (read_all(socket_fd, &length, 4) < 0) return;

    length = ntohl(length);
    if (length == 0 || length > MAX_FRAME) return;

    if (read_all(socket_fd, frame, length) < 0) return;

    // A TAP device takes one frame per write, and drops what it can't take.
    if (write(tap_fd, frame, length) < 0 && errno != EINTR) return;
  }
}

static int net(int argc, char **argv) {
  if (argc != 4 || strlen(argv[3]) >= IFNAMSIZ) usage();

  unsigned int port = parse_port(argv[2]);

  int tap_fd = open("/dev/net/tun", O_RDWR);
  if (tap_fd < 0) fail("/dev/net/tun");

  struct ifreq request = {0};
  request.ifr_flags = IFF_TAP | IFF_NO_PI;
  strncpy(request.ifr_name, argv[3], IFNAMSIZ - 1);

  if (ioctl(tap_fd, TUNSETIFF, &request) < 0) fail("TUNSETIFF");

  int socket_fd = connect_host(port);

  if (child()) {
    frames_to_host(tap_fd, socket_fd);
    _exit(0);
  }

  if (child()) {
    frames_from_host(socket_fd, tap_fd);
    _exit(0);
  }

  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) usage();

  if (strcmp(argv[1], "channels") == 0) return channels(argc, argv);
  if (strcmp(argv[1], "net") == 0) return net(argc, argv);

  usage();
}
