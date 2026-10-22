/* The mount table, for gnulib's mountlist (find -fstype): WASI has none
   to list, so it reads as empty (stubs.c: setmntent opens /dev/null). */
#pragma once
#include <stdio.h>
#define MOUNTED "/etc/mtab"
struct mntent { char *mnt_fsname; char *mnt_dir; char *mnt_type; char *mnt_opts; int mnt_freq; int mnt_passno; };
FILE *setmntent(const char *, const char *);
struct mntent *getmntent(FILE *);
int endmntent(FILE *);
char *hasmntopt(const struct mntent *, const char *);
