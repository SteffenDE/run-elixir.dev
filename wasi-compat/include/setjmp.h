/* setjmp without the jump: WASI has none without wasm's exception
   handling (wasi-libc's setjmp.h refuses). setjmp returns 0; a longjmp,
   which the tools here take only where WASI never leads them (gawk's
   debugger, diff -r's failing strcoll), ends the program saying so. */
#pragma once
#include <stdio.h>
#include <stdlib.h>
typedef int jmp_buf[1];
typedef int sigjmp_buf[1];
#define setjmp(env) 0
#define sigsetjmp(env, save) 0
#define longjmp(env, val) wasi_longjmp()
#define siglongjmp(env, val) wasi_longjmp()
static inline _Noreturn void wasi_longjmp(void) {
  fputs("longjmp: not on WASI (no exception handling)\n", stderr);
  exit(70);
}
