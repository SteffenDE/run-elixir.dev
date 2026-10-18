%% Node names to ports without epmd, for distribution between the
%% playground's nodes (-epmd_module playground_epmd): every node on the
%% one host, localhost, and a node's port derived from its name, so that
%% any node finds any other without asking. A proof of concept: two names
%% may share a port (PORTS of them), which a registry on the page would
%% not.
-module(playground_epmd).

-export([start_link/0, register_node/2, register_node/3, listen_port_please/2,
         port_please/2, port_please/3, address_please/3, names/0, names/1]).

-define(BASE, 20000).
-define(PORTS, 10000).
%% The distribution protocol's version, as epmd answers it.
-define(VERSION, 6).

start_link() ->
    ignore.

register_node(Name, Port) ->
    register_node(Name, Port, inet).

register_node(_Name, _Port, _Family) ->
    {ok, creation()}.

listen_port_please(Name, _Host) ->
    {ok, port(Name)}.

port_please(Name, Host) ->
    port_please(Name, Host, infinity).

port_please(Name, _Host, _Timeout) ->
    {port, port(Name), ?VERSION}.

address_please(Name, _Host, _Family) ->
    {ok, {127, 0, 0, 1}, port(Name), ?VERSION}.

names() ->
    names(localhost).

names(_Host) ->
    {error, address}.

%% Name: a string, or an atom (net_kernel passes either).
port(Name) when is_atom(Name) ->
    port(atom_to_list(Name));
port(Name) ->
    ?BASE + erlang:phash2(unicode:characters_to_binary(Name), ?PORTS).

%% A node's creation tells its incarnations apart; any nonzero 32-bit one.
creation() ->
    4 + rand:uniform(16#7fffffff).
