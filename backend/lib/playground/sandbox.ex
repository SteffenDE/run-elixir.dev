defmodule Playground.Sandbox do
  @moduledoc """
  Runs jobs in ephemeral Firecracker virtual machines.

  Each job gets a fresh VM that boots the kernel and root disk built by
  `Playground.Sandbox.Builder`. The root disk is read-only, jobs can only
  write to tmpfs mounts such as `/workspace` and `/tmp`, which disappear with
  the VM. Firecracker only runs on Linux with KVM.

  Adapted from SCA's sandbox, without QEMU, tracing or TLS interception.
  """

  alias Playground.Sandbox.Job
  alias Playground.Sandbox.Result
  alias Playground.Sandbox.VM

  @doc """
  Runs a job and waits for its result.

  Options:

    * `:artifacts_dir` - where the kernel, root disk, manifest and
      sandbox-netd are, defaults to the configured one or `priv/sandbox`
    * `:allow_reserved_destinations` - lets a job connect to addresses that
      aren't public, for tests only

  """
  @spec run(Job.t(), keyword()) :: {:ok, Result.t()} | {:error, term()}
  def run(%Job{} = job, opts \\ []) do
    child = {VM, {Playground.Sandbox.Firecracker, job, self(), opts}}

    with {:ok, vm} <- DynamicSupervisor.start_child(Playground.Sandbox.Supervisor, child) do
      ref = Process.monitor(vm)

      receive do
        {VM, ^vm, result} ->
          Process.demonitor(ref, [:flush])
          {:ok, result}

        {:DOWN, ^ref, :process, ^vm, reason} ->
          {:error, reason}
      end
    end
  end

  @doc """
  Returns the directory holding the VM's artifacts.
  """
  def artifacts_dir(opts \\ []) do
    Keyword.get_lazy(opts, :artifacts_dir, fn ->
      Application.get_env(:playground, __MODULE__, [])[:artifacts_dir] ||
        Application.app_dir(:playground, "priv/sandbox")
    end)
  end
end
