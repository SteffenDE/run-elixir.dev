defmodule Playground.Notification do
  @moduledoc """
  Something whoever runs the backend should hear about, whichever way they are told.

    * `:title` and `:body` - what it says; keep both short, a phone shows
      a line or two
    * `:url` - an absolute URL to open, or `nil`
    * `:level` - `:info`, `:warning` or `:critical`; a backend maps it to
      what it has, such as the urgency of a push message
    * `:tag` - notifications with the same tag replace each other where the
      backend supports that, or `nil`

  """

  @type t :: %__MODULE__{}

  @enforce_keys [:title]
  defstruct [:title, :url, :tag, body: "", level: :info]

  @levels [:info, :warning, :critical]

  @doc """
  Returns the notification as a map with string keys, for a job's args.
  """
  def dump(%__MODULE__{} = notification) do
    notification |> Map.from_struct() |> Map.new(fn {k, v} -> {to_string(k), dump_value(v)} end)
  end

  defp dump_value(level) when level in @levels, do: to_string(level)
  defp dump_value(value), do: value

  @doc """
  The inverse of `dump/1`.
  """
  def load(%{"title" => title} = map) do
    %__MODULE__{
      title: title,
      body: map["body"] || "",
      url: map["url"],
      tag: map["tag"],
      level: Enum.find(@levels, :info, &(to_string(&1) == map["level"]))
    }
  end
end
