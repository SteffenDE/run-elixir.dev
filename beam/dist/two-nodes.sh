#!/bin/bash
# Two nodes on the Emscripten BEAM, in one Node process over one Network
# (app/src/runtime/beam-node.ts), connected by OTP's distribution
# (docs/distribution.md): a@localhost waits with a registered echo
# process; b@localhost pings it, calls it (rpc, erpc with a fun), sends
# to the echo, sends it 1 MB, registers a global name a sees, and stops
# it, seeing nodedown.
#
#   beam/dist/two-nodes.sh [DIST]
#
# DIST: a dist build.sh wrote (default out/beam-wasm/releaseO1/dist, as
# `OPT=-O1 beam/build.sh release` makes it); the harness is the Vite
# build's (app/dist-node/beam-node.mjs); Node is emsdk's.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
DIST=${1:-$ROOT/out/beam-wasm/releaseO1/dist}
NODE=${NODE:-$(ls -d ~/emsdk/node/*/bin/node | tail -n 1)}
EBIN=$(mktemp -d)
trap 'rm -rf "$EBIN"' EXIT
erlc -o "$EBIN" "$HERE/playground_epmd.erl"

common=(-- -root /otp -bindir /otp/bin -progname erl -home /tmp -boot /otp/bin/start -noshell
        -pa /dist -kernel inet_backend socket -setcookie poc
        -proto_dist inet_epmd -inet_epmd socket -epmd_module playground_epmd)
a='register(echo, spawn(fun Loop() -> receive {From, M} -> From ! {echo, node(), M}, Loop() end end)),
   io:format("a: ~p alive ~p~n", [node(), is_alive()]).'
b='timer:sleep(3000),
   T0 = erlang:monotonic_time(millisecond),
   P = net_adm:ping(a@localhost),
   io:format("b: ~p ping ~p in ~p ms, nodes ~p~n", [node(), P, erlang:monotonic_time(millisecond) - T0, nodes()]),
   io:format("b: rpc ~p~n", [rpc:call(a@localhost, erlang, system_info, [otp_release])]),
   io:format("b: erpc ~p~n", [erpc:call(a@localhost, fun() -> {node(), lists:sum(lists:seq(1, 100))} end)]),
   {echo, a@localhost} ! {self(), hello},
   receive E -> io:format("b: got ~p~n", [E]) after 5000 -> io:format("b: no echo~n") end,
   Big = binary:copy(<<"x">>, 1000000),
   T1 = erlang:monotonic_time(millisecond),
   Size = erpc:call(a@localhost, erlang, byte_size, [Big]),
   io:format("b: 1 MB there in ~p ms (~p)~n", [erlang:monotonic_time(millisecond) - T1, Size]),
   yes = global:register_name(b_global, self()),
   timer:sleep(500),
   io:format("b: global on a ~p~n", [erpc:call(a@localhost, global, whereis_name, [b_global]) =:= self()]),
   monitor_node(a@localhost, true),
   rpc:cast(a@localhost, init, stop, []),
   receive {nodedown, N} -> io:format("b: nodedown ~p~n", [N]) after 10000 -> io:format("b: no nodedown~n") end,
   init:stop().'
MOUNT=/dist:$EBIN timeout 60 "$NODE" "$ROOT/app/dist-node/beam-node.mjs" "$DIST" \
  -S 2:2 "${common[@]}" -sname a -eval "$a" --- -S 2:2 "${common[@]}" -sname b -eval "$b"
