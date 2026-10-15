defmodule Playground.Sandbox.GuestScript do
  @moduledoc false

  # Builds the shell script the guest init runs as root to start a job.
  #
  # The init opens the job's stdout and stderr channels on descriptors 4 and 5.
  # Only the command itself is redirected onto them, so that failures while
  # preparing it end up in the system log instead of the job's output.
  #
  # The input channel is open on descriptor 6 and carries the workspace archive.
  # The host doesn't close it afterwards, so the script is told the archive's
  # size and reads exactly that much. It's also told whether the archive is
  # gzip-compressed, which tar can't detect when reading from a pipe. The archive
  # is untrusted, so it's extracted by the job user.

  alias Playground.Sandbox.Job

  @uid 1000
  @gid 1000
  @setpriv "setpriv --reuid=#{@uid} --regid=#{@gid} --clear-groups --no-new-privs"

  @environment %{
    "LANG" => "C.UTF-8",
    "MIX_HOME" => "/usr/local/lib/mix",
    "PATH" => "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  }

  @type workspace_archive :: %{size: non_neg_integer(), gzip?: boolean()}

  @doc """
  Returns the script for a job.

  Options:

    * `:workspace_archive` - describes the job's workspace archive

  """
  @spec build(Job.t(), keyword()) :: String.t()
  def build(%Job{} = job, opts \\ []) do
    working_directory = escape(job.working_directory)

    environment =
      @environment
      |> Map.put("HOME", job.working_directory)
      |> Map.merge(job.environment)
      |> Enum.sort()
      |> Enum.map_join(" ", fn {key, value} -> escape("#{key}=#{value}") end)

    command = Enum.map_join(job.command, " ", &escape/1)

    # The job user owns /workspace, as tar applies the mode and times of an
    # archive's ./ entry to it. The working directory is created before the
    # archive can put a symlink in its place. /run/job-started tells the init
    # that everything before the command succeeded, the job user can't create it.
    """
    set -eu
    chown #{@uid}:#{@gid} /workspace
    mkdir -p #{working_directory}
    chown #{@uid}:#{@gid} #{working_directory}
    #{extract(opts[:workspace_archive])}
    cd #{working_directory}
    : >/run/job-started
    exec #{@setpriv} \\
      env -i -- #{environment} #{command} \\
      >&4 2>&5 4>&- 5>&- 6<&-
    """
  end

  defp extract(nil), do: ""

  defp extract(%{size: size, gzip?: gzip?}) do
    flags = if gzip?, do: "-xzf", else: "-xf"

    "head -c #{size} <&6 | #{@setpriv} tar #{flags} - -C /workspace"
  end

  defp escape(value), do: "'" <> String.replace(value, "'", ~S('\'')) <> "'"
end
