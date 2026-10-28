sha=$(sed -n 's/^ *@lexbor_git_sha "\([0-9a-f]*\)".*/\1/p' mix.exs)
lexbor="$SRC/_build/c/third_party/lexbor/$sha"
mkdir -p "$lexbor"
curl -fsSL "https://codeload.github.com/lexbor/lexbor/tar.gz/$sha" | tar -xz --strip-components=1 -C "$lexbor"
cmake -S "$lexbor" -B "$lexbor/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=/opt/wasi-sdk/share/cmake/wasi-sdk-p1.cmake -DCMAKE_BUILD_TYPE=Release \
  -DLEXBOR_BUILD_SHARED=OFF -DLEXBOR_BUILD_STATIC=ON -DLEXBOR_BUILD_SEPARATELY=OFF >/dev/null
cmake --build "$lexbor/build" >/dev/null
mix deps.get --only prod >/dev/null
LEXBOR_GIT_SHA="$sha" FINE_INCLUDE_DIR="$SRC/deps/fine/c_include" make
