defmodule Playground.Sandbox.Job do
  @moduledoc """
  A command to run in a sandbox VM.

  The command is a list of arguments and is never interpreted by a shell. It
  runs as an unprivileged user with UID and GID 1000, in `working_directory`,
  which is also its `HOME`.

  The environment only contains `PATH`, `LANG` and `MIX_HOME` as set by the
  sandbox image, with `environment` merged on top.

  `workspace_archive` is a tar file on the host, optionally gzip-compressed.
  The job user extracts it into `/workspace` before the command runs.

  At most `max_output` bytes of stdout and of stderr are kept, 64 MiB by
  default.

  `network` is `:none` by default, the VM has no network interface then. With
  `:mediated`, every TCP connection the job opens is made from the host on its
  behalf and recorded, as long as it goes to a public address whose name is in
  `allowed_hosts` (see `Playground.Sandbox.Destination.allowed?/2`). Names
  resolve to placeholder addresses in the VM, and UDP only reaches DNS.
  """

  @enforce_keys [:command]
  defstruct command: nil,
            working_directory: "/workspace",
            environment: %{},
            workspace_archive: nil,
            network: :none,
            allowed_hosts: [],
            timeout: to_timeout(minute: 1),
            cpus: 2,
            memory_mib: 4096,
            max_output: 64 * 1024 * 1024

  @type t :: %__MODULE__{
          command: [String.t(), ...],
          working_directory: Path.t(),
          environment: %{optional(String.t()) => String.t()},
          workspace_archive: Path.t() | nil,
          network: :none | :mediated,
          allowed_hosts: [String.t()],
          timeout: pos_integer(),
          cpus: pos_integer(),
          memory_mib: pos_integer(),
          max_output: pos_integer()
        }
end
