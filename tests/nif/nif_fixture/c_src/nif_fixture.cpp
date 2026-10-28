// A NIF library in C++ for the playground's tests: a call, and a C++
// exception caught and raised as an Elixir one (WebAssembly's exceptions,
// nifc++).
#include <erl_nif.h>

#include <stdexcept>
#include <string>

static ERL_NIF_TERM add(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
  long a, b;
  if (!enif_get_long(env, argv[0], &a) || !enif_get_long(env, argv[1], &b)) return enif_make_badarg(env);
  return enif_make_long(env, a + b);
}

static ERL_NIF_TERM parse(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
  ErlNifBinary bin;
  if (!enif_inspect_binary(env, argv[0], &bin)) return enif_make_badarg(env);
  std::string text(reinterpret_cast<const char *>(bin.data), bin.size);
  try {
    return enif_make_int(env, std::stoi(text));
  } catch (const std::exception &error) {
    std::string message = std::string("not an integer: ") + error.what();
    ErlNifBinary out;
    enif_alloc_binary(message.size(), &out);
    message.copy(reinterpret_cast<char *>(out.data), message.size());
    return enif_raise_exception(env, enif_make_binary(env, &out));
  }
}

static ErlNifFunc functions[] = {{"add", 2, add, 0}, {"parse", 1, parse, 0}};

ERL_NIF_INIT(Elixir.NifFixture, functions, NULL, NULL, NULL, NULL)
