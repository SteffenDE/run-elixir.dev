// The terminal's mode for the playground (patch 0017): when the shell
// switches standard input to raw and back, the host's Module.onTtyMode
// hears it on the main thread (Rust-OTP writes /.tty/mode instead).
addToLibrary({
  wasm_tty_mode__proxy: 'async',
  wasm_tty_mode__sig: 'vi',
  wasm_tty_mode: (raw) => {
    Module['onTtyMode']?.(!!raw);
  },
});
