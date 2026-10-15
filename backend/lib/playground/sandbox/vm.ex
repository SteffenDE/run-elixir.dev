defmodule Playground.Sandbox.VM do
  @moduledoc false

  # Runs one job in a VM and sends the result to its owner. A backend
  # (Playground.Sandbox.Firecracker) starts the VM and connects its channels:
  #
  #   * control - the guest reports SANDBOX_READY, receives SANDBOX_JOB <marker> <script>,
  #     reports SANDBOX_EXIT <status>, or SANDBOX_SETUP_FAILED <status> when the job
  #     failed before its command ran, and powers off once it receives
  #     SANDBOX_SHUTDOWN
  #   * stdout and stderr - the job's output, each ended by the marker
  #   * input - the job's workspace archive
  #
  # The VMM's output, which includes the serial console, is the system log.
  #
  # With a mediated network, the guest's network interface is
  # connected to sandbox-netd, which hands its TCP connections to
  # Playground.Sandbox.Network.

  use GenServer, restart: :temporary

  alias Playground.Sandbox
  alias Playground.Sandbox.GuestScript
  alias Playground.Sandbox.Job
  alias Playground.Sandbox.Network
  alias Playground.Sandbox.Output
  alias Playground.Sandbox.Result

  @type channel :: :control | :stdout | :stderr | :input

  @typedoc "What a backend needs to start a VM."
  @type config :: %{
          artifacts_dir: Path.t(),
          dir: Path.t(),
          kernel_args: String.t(),
          channels: [channel()]
        }

  @doc """
  Returns the path of the unix socket the VM connects to sandbox-netd on, which
  listens there before the VM starts.
  """
  @callback netd_socket(dir :: Path.t()) :: Path.t()

  @doc """
  Prepares everything the VMM needs and returns the program to start, with its
  arguments. The state is passed on to `c:connect/3`.
  """
  @callback prepare(Job.t(), config()) ::
              {:ok, executable :: Path.t(), args :: [String.t()], state :: term()}
              | {:error, term()}

  @doc """
  Connects the channels of the VM the port started, before the deadline, a
  monotonic time in milliseconds. Sockets must be active, and in binary mode.

  When the VM exits before every channel is connected, returns those that are,
  so that the VM is reported as crashed, with its system log.
  """
  @callback connect(state :: term(), port(), deadline :: integer()) ::
              {:ok, %{:gen_tcp.socket() => channel()}} | :error

  @channels [:control, :stdout, :stderr, :input]

  # Some backends' guests only connect once they have booted.
  @connect_timeout 30_000

  # Only reached when the guest dies before writing its markers.
  @shutdown_deadline 2_000

  # The guest's address, gateway and name server, where sandbox-netd answers.
  @guest_network "10.0.2.15/24,10.0.2.2,10.0.2.2"

  def start_link({backend, job, owner, opts}) do
    GenServer.start_link(__MODULE__, {backend, job, owner, opts})
  end

  @impl GenServer
  def init({backend, job, owner, opts}) do
    # Supervisor shutdowns arrive as exit signals, which only reach terminate/2
    # when they are trapped. The owner going away stops the VM too.
    Process.flag(:trap_exit, true)
    Process.monitor(owner)

    artifacts_dir = Sandbox.artifacts_dir(opts)
    dir = Path.join(System.tmp_dir!(), "sandbox-vm-#{System.unique_integer([:positive])}")

    with {:ok, workspace_archive} <- describe(job.workspace_archive),
         {:ok, partition_uuid} <- partition_uuid(artifacts_dir),
         :ok <- File.mkdir_p(dir),
         :ok <- File.chmod(dir, 0o700),
         {:ok, network, netd} <- start_network(backend, job, artifacts_dir, dir, opts),
         config = %{
           artifacts_dir: artifacts_dir,
           dir: dir,
           kernel_args: kernel_args(job, partition_uuid),
           channels: @channels
         },
         {:ok, executable, args, backend_state} <- backend.prepare(job, config) do
      port =
        Port.open({:spawn_executable, executable}, [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          args: args
        ])

      {:os_pid, os_pid} = Port.info(port, :os_pid)
      deadline = System.monotonic_time(:millisecond) + @connect_timeout

      case backend.connect(backend_state, port, deadline) do
        {:ok, sockets} ->
          Process.send_after(self(), :job_timeout, job.timeout)
          stream(socket_for(sockets, :input), job.workspace_archive)

          # Random, so that a job can't end its own output early by printing it.
          marker = "SANDBOX_EOF_" <> Base.encode16(:crypto.strong_rand_bytes(16))

          {:ok,
           %{
             owner: owner,
             port: port,
             os_pid: os_pid,
             dir: dir,
             marker: marker,
             script: Base.encode64(GuestScript.build(job, workspace_archive: workspace_archive)),
             started_at: System.monotonic_time(:millisecond),
             sockets: sockets,
             network: network,
             netd: netd,
             control_buffer: "",
             exit_status: nil,
             setup_failed?: false,
             shutdown?: false,
             timed_out?: false,
             system_log: [],
             outputs: %{
               stdout: Output.new(marker, job.max_output),
               stderr: Output.new(marker, job.max_output)
             }
           }}

        :error ->
          kill(os_pid)
          output = await_exit(port, [])
          File.rm_rf(dir)
          {:stop, {:vm_failed, output}}
      end
    else
      {:error, reason} ->
        File.rm_rf(dir)
        {:stop, reason}
    end
  end

  @impl GenServer
  def handle_info({port, {:data, data}}, %{port: port} = state) do
    {:noreply, %{state | system_log: [state.system_log | data]}}
  end

  def handle_info({port, {:exit_status, _status}}, %{port: port} = state) do
    maybe_finish(%{state | port: nil})
  end

  def handle_info({netd, {:data, {_eol, line}}}, %{netd: netd} = state) do
    {:noreply, %{state | system_log: [state.system_log, line, ?\n]}}
  end

  # sandbox-netd exits once the VM is gone.
  def handle_info({netd, {:exit_status, _status}}, %{netd: netd} = state) do
    {:noreply, state}
  end

  def handle_info({:tcp, socket, data}, state) do
    case Map.fetch!(state.sockets, socket) do
      :control ->
        {:noreply, control(state, socket, data)}

      channel ->
        state = update_in(state, [:outputs, channel], &Output.append(&1, data))

        {:noreply, maybe_shutdown(state, socket_for(state.sockets, :control))}
    end
  end

  def handle_info({:tcp_closed, socket}, state) do
    maybe_finish(%{state | sockets: Map.delete(state.sockets, socket)})
  end

  def handle_info({:tcp_error, socket, _reason}, state) do
    :gen_tcp.close(socket)
    maybe_finish(%{state | sockets: Map.delete(state.sockets, socket)})
  end

  # Killed, the VMM exits and closes its sockets like it would otherwise, which
  # is what reports the result.
  def handle_info(:job_timeout, %{port: nil} = state), do: {:noreply, state}

  def handle_info(:job_timeout, state) do
    kill(state.os_pid)
    {:noreply, %{state | timed_out?: true}}
  end

  def handle_info(:shutdown_deadline, %{shutdown?: false} = state) do
    {:noreply, shutdown(state, socket_for(state.sockets, :control))}
  end

  def handle_info(:shutdown_deadline, state), do: {:noreply, state}

  def handle_info({:DOWN, _ref, :process, owner, _reason}, %{owner: owner} = state) do
    {:stop, :normal, state}
  end

  # The port and sockets are linked, so their exits arrive as messages.
  def handle_info({:EXIT, _port_or_socket, _reason}, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, state) do
    if state.port, do: kill(state.os_pid)
    File.rm_rf(state.dir)
  end

  defp control(state, socket, data) do
    [buffer | lines] = (state.control_buffer <> data) |> String.split("\n") |> Enum.reverse()

    lines
    |> Enum.reverse()
    |> Enum.reduce(%{state | control_buffer: buffer}, fn
      "SANDBOX_READY", state ->
        :ok = :gen_tcp.send(socket, ["SANDBOX_JOB ", state.marker, " ", state.script, "\n"])
        state

      "SANDBOX_EXIT " <> status, state ->
        Process.send_after(self(), :shutdown_deadline, @shutdown_deadline)
        maybe_shutdown(%{state | exit_status: String.to_integer(status)}, socket)

      "SANDBOX_SETUP_FAILED " <> _status, state ->
        Process.send_after(self(), :shutdown_deadline, @shutdown_deadline)
        maybe_shutdown(%{state | setup_failed?: true}, socket)

      _line, state ->
        state
    end)
  end

  # Whether the markers or the exit status arrive first depends on the order the
  # sockets are read in.
  defp maybe_shutdown(%{shutdown?: false} = state, socket) do
    reported? = is_integer(state.exit_status) or state.setup_failed?

    if reported? and output_complete?(state), do: shutdown(state, socket), else: state
  end

  defp maybe_shutdown(state, _socket), do: state

  # The guest may already be gone, in which case there's nobody to tell.
  defp shutdown(state, socket) do
    if socket, do: :gen_tcp.send(socket, "SANDBOX_SHUTDOWN\n")
    %{state | shutdown?: true}
  end

  defp output_complete?(state) do
    Enum.all?(state.outputs, fn {_channel, output} -> output.complete? end)
  end

  defp socket_for(sockets, channel) do
    Enum.find_value(sockets, fn
      {socket, ^channel} -> socket
      _other -> nil
    end)
  end

  # The VMM's sockets close when it exits, and they report being closed only
  # after everything that was written to them.
  defp maybe_finish(%{port: nil, sockets: sockets} = state) when map_size(sockets) == 0 do
    network =
      if state.network,
        do: Network.report(state.network),
        else: %{connections: [], lookups: [], blocked: []}

    result = %Result{
      status: status(state),
      exit_status: state.exit_status,
      stdout: Output.to_binary(state.outputs.stdout),
      stderr: Output.to_binary(state.outputs.stderr),
      output_complete?: output_complete?(state),
      output_truncated?: Enum.any?(state.outputs, fn {_channel, output} -> output.truncated? end),
      system_log: IO.iodata_to_binary(state.system_log),
      connections: network.connections,
      lookups: network.lookups,
      blocked: network.blocked,
      duration_ms: System.monotonic_time(:millisecond) - state.started_at
    }

    send(state.owner, {__MODULE__, self(), result})
    {:stop, :normal, state}
  end

  defp maybe_finish(state), do: {:noreply, state}

  # A job that reported its exit status just before the timeout still exited.
  defp status(%{setup_failed?: true}), do: :setup_failed
  defp status(%{exit_status: status}) when is_integer(status), do: :exited
  defp status(%{timed_out?: true}), do: :timeout
  defp status(_state), do: :crashed

  defp describe(nil), do: {:ok, nil}

  defp describe(path) do
    with {:ok, %File.Stat{type: :regular, size: size}} <- File.stat(path),
         {:ok, magic} <- File.open(path, [:read, :binary], &IO.binread(&1, 2)) do
      {:ok, %{size: size, gzip?: magic == <<0x1F, 0x8B>>}}
    else
      {:ok, %File.Stat{}} -> {:error, {:workspace_archive, :not_a_regular_file}}
      {:error, reason} -> {:error, {:workspace_archive, reason}}
    end
  end

  # The guest only reads the archive when the job script gets to it, and sending
  # blocks until then, so this happens in a separate process. It's linked, and
  # ends with the VM.
  defp stream(nil, _path), do: :ok
  defp stream(_socket, nil), do: :ok

  defp stream(socket, path) do
    spawn_link(fn ->
      path
      |> File.stream!(65_536)
      |> Enum.reduce_while(:ok, fn chunk, :ok ->
        case :gen_tcp.send(socket, chunk) do
          :ok -> {:cont, :ok}
          {:error, _reason} -> {:halt, :error}
        end
      end)
    end)

    :ok
  end

  defp start_network(_backend, %{network: :none}, _artifacts_dir, _dir, _opts),
    do: {:ok, nil, nil}

  # sandbox-netd listens for the VM, so it has to be ready before the VM starts. It
  # exits when its stdin closes, which happens when this process ends.
  defp start_network(backend, job, artifacts_dir, dir, opts) do
    netd = Path.join(artifacts_dir, "sandbox-netd")
    proxy_path = Path.join(dir, "proxy.sock")

    network_opts = [
      path: proxy_path,
      allowed_hosts: job.allowed_hosts,
      allow_reserved: Keyword.get(opts, :allow_reserved_destinations, false)
    ]

    if File.regular?(netd) do
      with {:ok, network} <- Network.start_link(network_opts) do
        port =
          Port.open({:spawn_executable, netd}, [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            line: 1024,
            args: ["-vm", backend.netd_socket(dir), "-proxy", proxy_path]
          ])

        receive do
          {^port, {:data, {:eol, "SANDBOX_NETD_READY"}}} -> {:ok, network, port}
          {^port, {:exit_status, status}} -> {:error, {:netd_failed, status}}
        after
          @connect_timeout -> {:error, :netd_timeout}
        end
      end
    else
      {:error, {:missing_artifact, netd}}
    end
  end

  defp partition_uuid(artifacts_dir) do
    case File.read(Path.join(artifacts_dir, "manifest.json")) do
      {:ok, manifest} -> {:ok, JSON.decode!(manifest)["partition_uuid"]}
      {:error, reason} -> {:error, {:manifest, reason}}
    end
  end

  defp await_exit(port, output) do
    receive do
      {^port, {:data, data}} -> await_exit(port, [output, data])
      {^port, {:exit_status, _status}} -> IO.iodata_to_binary(output)
    end
  end

  # The shell's kill, as slim images don't have a kill executable.
  defp kill(os_pid) do
    System.cmd("sh", ["-c", ~s(kill -KILL "$1"), "sh", Integer.to_string(os_pid)],
      stderr_to_stdout: true
    )
  end

  defp kernel_args(job, partition_uuid) do
    kernel_args = "panic=1 root=PARTUUID=#{partition_uuid} ro init=/usr/lib/sandbox/sandbox-init"

    case job.network do
      :none -> kernel_args
      :mediated -> kernel_args <> " sandbox.net=#{@guest_network}"
    end
  end
end
