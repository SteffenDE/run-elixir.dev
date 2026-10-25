defmodule Playground.Relay.ClientHello do
  @moduledoc """
  Reads the server name from the first bytes of a TLS connection: a
  handshake record holding a ClientHello, and its `server_name` extension.

  The relay passes a connection's bytes on only once they start this way and
  name the host it was opened to: no plain text, and no other site behind an
  allowed one's address (a CDN's).
  """

  # A record's fragment is at most 2^14 bytes, and a ClientHello fits in one.
  @max_fragment 16_384

  @doc "The most bytes `server_name/1` needs before it can answer."
  def max_size, do: 5 + @max_fragment

  @doc """
  The ClientHello's server name, `:more` until the first record is all there,
  or `:error` (not TLS, not a ClientHello, no server name).

      iex> Playground.Relay.ClientHello.server_name("GET / HTTP/1.1\\r\\n")
      :error
      iex> Playground.Relay.ClientHello.server_name(<<22, 3, 1>>)
      :more

  """
  @spec server_name(binary()) :: {:ok, String.t()} | :more | :error
  def server_name(<<22, 3, minor, length::16, rest::binary>>) when minor <= 4 do
    cond do
      length > @max_fragment -> :error
      byte_size(rest) < length -> :more
      true -> rest |> binary_part(0, length) |> handshake()
    end
  end

  def server_name(bytes) when byte_size(bytes) < 5 do
    if String.starts_with?(<<22, 3>>, binary_part(bytes, 0, min(byte_size(bytes), 2))),
      do: :more,
      else: :error
  end

  def server_name(_bytes), do: :error

  defp handshake(<<1, length::24, hello::binary-size(length), _::binary>>), do: hello(hello)
  defp handshake(_), do: :error

  defp hello(
         <<_version::16, _random::binary-size(32), session_length,
           _session::binary-size(session_length), suites_length::16,
           _suites::binary-size(suites_length), methods_length,
           _methods::binary-size(methods_length), extensions_length::16,
           extensions::binary-size(extensions_length), _::binary>>
       ),
       do: extension(extensions)

  defp hello(_), do: :error

  defp extension(<<0::16, length::16, data::binary-size(length), _::binary>>), do: name(data)

  defp extension(<<_type::16, length::16, _::binary-size(length), rest::binary>>),
    do: extension(rest)

  defp extension(_), do: :error

  # The list's host_name entry (type 0).
  defp name(<<list_length::16, list::binary-size(list_length)>>), do: host_name(list)
  defp name(_), do: :error

  defp host_name(<<0, length::16, name::binary-size(length), _::binary>>) do
    if String.valid?(name) and name != "", do: {:ok, name}, else: :error
  end

  defp host_name(<<_type, length::16, _::binary-size(length), rest::binary>>), do: host_name(rest)
  defp host_name(_), do: :error
end
