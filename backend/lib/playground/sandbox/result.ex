defmodule Playground.Sandbox.Result do
  @moduledoc """
  The result of a sandbox job, including command outputs and system log.

  `status` is one of:

    * `:exited` - the command exited with `exit_status`
    * `:setup_failed` - preparing the job failed before its command ran, for
      example extracting an input, the `system_log` says why
    * `:timeout` - the job didn't finish within its timeout and the VM was killed
    * `:crashed` - the VM stopped without reporting an exit status, the
      `system_log` says why

  `stdout` and `stderr` are written by the job and must be treated as untrusted.
  `output_complete?` says whether they were read to their end. It's false when
  the job timed out or the VM crashed, in which case output may be missing.
  `output_truncated?` says whether either was longer than the job's
  `max_output`, and cut there.
  `system_log` is the VM's console, including the kernel log.

  When the job ran with a mediated network, `connections` lists the TCP
  connections it opened, see `Playground.Sandbox.Connection`. `lookups` lists
  the names it looked up and `blocked` the traffic that went nowhere, see
  `Playground.Sandbox.Blocked`. Both record each distinct entry once, up to
  4096 in total, which is handled by sandbox-netd.
  """

  @enforce_keys [
    :status,
    :exit_status,
    :stdout,
    :stderr,
    :output_complete?,
    :output_truncated?,
    :system_log,
    :connections,
    :lookups,
    :blocked,
    :duration_ms
  ]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          status: :exited | :setup_failed | :timeout | :crashed,
          exit_status: non_neg_integer() | nil,
          stdout: binary(),
          stderr: binary(),
          output_complete?: boolean(),
          output_truncated?: boolean(),
          system_log: binary(),
          connections: [Playground.Sandbox.Connection.t()],
          lookups: [String.t()],
          blocked: [Playground.Sandbox.Blocked.t()],
          duration_ms: non_neg_integer()
        }
end
