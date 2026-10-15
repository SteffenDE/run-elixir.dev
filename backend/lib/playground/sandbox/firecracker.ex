defmodule Playground.Sandbox.Firecracker do
  @moduledoc false

  # Runs a VM with Firecracker, see Playground.Sandbox.VM. It only runs on Linux with
  # KVM, but needs no privileges beyond access to /dev/kvm.
  #
  # Firecracker has no virtio-serial, so the guest init connects to the host
  # over vsock with sandbox-vsock, which it's told to by sandbox.transport=vsock. A
  # connection to a port P ends up at the unix socket <uds_path>_P, which this
  # module listens on for each channel:
  #
  #   1 control, 2 stdout, 3 stderr, 4 input, 6 network
  #
  # Each listener is closed once it accepted a connection, so that a job can't
  # connect to a channel itself. sandbox-netd listens on the network's socket, and
  # only ever accepts one connection too.
  #
  # Firecracker only exits when an x86 guest resets, so the guest init reboots
  # rather than powering off. Firecracker can't exit with its parent, so it's
  # started by setpriv, which has it killed when the BEAM dies.

  @behaviour Playground.Sandbox.VM

  @ports %{control: 1, stdout: 2, stderr: 3, input: 4}
  @network_port 6
  @guest_cid 3

  @impl true
  def netd_socket(dir), do: socket_path(dir, @network_port)

  @impl true
  def prepare(job, config) do
    with {:ok, setpriv} <- find_executable("setpriv"),
         {:ok, firecracker} <- find_executable("firecracker"),
         :ok <- File.write(config_path(config.dir), JSON.encode!(vm_config(job, config))),
         {:ok, listeners} <- listen(config) do
      args = [
        "--pdeathsig",
        "KILL",
        "--",
        firecracker,
        "--no-api",
        "--config-file",
        config_path(config.dir)
      ]

      {:ok, setpriv, args, listeners}
    end
  end

  # The guest connects the channels one after another, in order.
  @impl true
  def connect(listeners, port, deadline) do
    Enum.reduce_while(listeners, {:ok, %{}}, fn {channel, listener}, {:ok, sockets} ->
      case accept(listener, port, deadline) do
        {:ok, socket} ->
          :gen_tcp.close(listener)
          {:cont, {:ok, Map.put(sockets, socket, channel)}}

        :exited ->
          close(listeners)
          {:halt, {:ok, sockets}}

        :timeout ->
          close(listeners)
          Enum.each(sockets, fn {socket, _channel} -> :gen_tcp.close(socket) end)
          {:halt, :error}
      end
    end)
  end

  # Polls, as the VM exiting only shows as a message this process must not take
  # from its mailbox.
  defp accept(listener, port, deadline) do
    case :gen_tcp.accept(listener, 10) do
      {:ok, socket} ->
        {:ok, socket}

      {:error, :timeout} ->
        cond do
          is_nil(Port.info(port)) -> :exited
          System.monotonic_time(:millisecond) >= deadline -> :timeout
          true -> accept(listener, port, deadline)
        end
    end
  end

  defp listen(config) do
    Enum.reduce_while(config.channels, {:ok, []}, fn channel, {:ok, listeners} ->
      path = socket_path(config.dir, Map.fetch!(@ports, channel))

      case :gen_tcp.listen(0, [:binary, active: true, ifaddr: {:local, path}]) do
        {:ok, listener} ->
          {:cont, {:ok, listeners ++ [{channel, listener}]}}

        {:error, reason} ->
          close(listeners)
          {:halt, {:error, {:listen, path, reason}}}
      end
    end)
  end

  defp close(listeners) do
    Enum.each(listeners, fn {_channel, listener} -> :gen_tcp.close(listener) end)
  end

  defp vm_config(job, config) do
    {kernel, console_args} = machine()
    vsock = %{guest_cid: @guest_cid, uds_path: Path.join(config.dir, "vsock.sock")}

    %{
      "boot-source": %{
        kernel_image_path: Path.join(config.artifacts_dir, kernel),
        boot_args: "#{console_args} #{config.kernel_args} sandbox.transport=vsock"
      },
      drives: [
        %{
          drive_id: "rootfs",
          path_on_host: Path.join(config.artifacts_dir, "rootfs.raw"),
          is_root_device: false,
          is_read_only: true
        }
      ],
      "machine-config": %{vcpu_count: job.cpus, mem_size_mib: job.memory_mib},
      vsock: vsock
    }
  end

  # Firecracker boots an uncompressed kernel, which on arm64 is what QEMU boots
  # too. It has no PCI bus unless asked for one.
  defp machine do
    case List.to_string(:erlang.system_info(:system_architecture)) do
      "aarch64" <> _ -> {"kernel", "console=ttyS0 reboot=k"}
      "x86_64" <> _ -> {"vmlinux", "console=ttyS0 reboot=k pci=off"}
    end
  end

  defp find_executable(name) do
    case System.find_executable(name) do
      nil -> {:error, {:executable_not_found, name}}
      path -> {:ok, path}
    end
  end

  defp config_path(dir), do: Path.join(dir, "firecracker.json")

  defp socket_path(dir, port), do: Path.join(dir, "vsock.sock_#{port}")
end
