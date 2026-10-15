defmodule Playground.Sandbox.Destination do
  @moduledoc false

  # Resolves where a job's connection goes. Connections are made from the host,
  # so a job must only reach public addresses: not the host itself, not its
  # private network and not a cloud metadata service. And only hosts it is
  # allowed to: a build fetches its sources, nothing else.

  # See https://en.wikipedia.org/wiki/Reserved_IP_addresses
  @reserved_v4 [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "233.252.0.0/24",
    "240.0.0.0/4",
    "255.255.255.255/32"
  ]

  @reserved_v6 [
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "::ffff:0:0:0/96",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001:0000::/32",
    "2001:20::/28",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8"
  ]

  @doc """
  Returns whether a name is one of `allowed`: a name, or `*.domain` for every
  name below that domain.

      iex> allowed?("codeload.github.com", ["github.com", "*.github.com"])
      true
      iex> allowed?("github.com.evil.example", ["github.com"])
      false

  """
  @spec allowed?(String.t() | nil, [String.t()]) :: boolean()
  def allowed?(nil, _allowed), do: false

  def allowed?(name, allowed) do
    name = name |> String.downcase() |> String.trim_trailing(".")

    Enum.any?(allowed, fn
      "*." <> domain -> String.ends_with?(name, "." <> String.downcase(domain))
      host -> name == String.downcase(host)
    end)
  end

  @doc """
  Returns the addresses to connect to for a host, unless any of them is reserved.

  A name that resolves to both public and reserved addresses is denied as a
  whole. The returned addresses are the ones to connect to, so that the name
  can't resolve differently once it has been checked.

  Options:

    * `:allow_reserved` - allows reserved addresses, for tests only

  """
  @spec resolve(String.t(), keyword()) :: {:ok, [:inet.ip_address()]} | {:error, term()}
  def resolve(host, opts \\ []) do
    with {:ok, addresses} <- addresses(host) do
      if Keyword.get(opts, :allow_reserved, false) or not Enum.any?(addresses, &reserved?/1) do
        {:ok, addresses}
      else
        {:error, :reserved_address}
      end
    end
  end

  defp addresses(host) do
    host = String.to_charlist(host)

    case :inet.parse_strict_address(host) do
      {:ok, address} ->
        {:ok, [address]}

      {:error, _reason} ->
        addresses =
          for family <- [:inet, :inet6],
              {:ok, addresses} <- [:inet.getaddrs(host, family)],
              address <- addresses,
              do: address

        if addresses == [], do: {:error, :nxdomain}, else: {:ok, addresses}
    end
  end

  defp reserved?({a, b, c, d}), do: reserved?(:inet, <<a, b, c, d>>)

  defp reserved?({a, b, c, d, e, f, g, h}) do
    reserved?(:inet6, <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>>)
  end

  # One clause per range, matching the address's binary representation by its
  # prefix. 10.0.0.0/8, for example, matches every address starting with 10.
  for {family, ranges} <- [inet: @reserved_v4, inet6: @reserved_v6], range <- ranges do
    [network, prefix_length] = String.split(range, "/")
    prefix_length = String.to_integer(prefix_length)

    network =
      case :inet.parse_strict_address(String.to_charlist(network)) do
        {:ok, {a, b, c, d}} ->
          <<a, b, c, d>>

        {:ok, {a, b, c, d, e, f, g, h}} ->
          <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>>
      end

    prefix = Macro.escape(<<network::bits-size(prefix_length)>>)

    defp reserved?(unquote(family), <<unquote(prefix), _rest::bitstring>>), do: true
  end

  defp reserved?(_family, _address), do: false
end
