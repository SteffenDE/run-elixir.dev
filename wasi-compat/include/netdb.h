#pragma once
#include <sys/socket.h>
struct hostent { char *h_name; char **h_aliases; int h_addrtype; int h_length; char **h_addr_list; };
#define h_addr h_addr_list[0]
struct hostent *gethostbyname(const char *);
const char *hstrerror(int);
extern int h_errno;
