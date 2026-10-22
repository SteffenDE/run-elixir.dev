#pragma once
typedef unsigned tcflag_t; typedef unsigned char cc_t;
struct termios { tcflag_t c_iflag, c_oflag, c_cflag, c_lflag; cc_t c_cc[32]; };
#define ECHO 8
#define ICANON 2
#define VMIN 6
#define VTIME 5
#define TCSAFLUSH 2
int tcgetattr(int, struct termios *);
int tcsetattr(int, int, const struct termios *);
