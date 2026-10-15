defmodule Playground.SandboxTest do
  use ExUnit.Case, async: true, group: :sandbox

  alias Playground.Sandbox
  alias Playground.Sandbox.Blocked
  alias Playground.Sandbox.Builder
  alias Playground.Sandbox.Connection
  alias Playground.Sandbox.Firecracker
  alias Playground.Sandbox.Job
  alias Playground.Sandbox.Result
  alias Playground.Sandbox.VM

  @moduletag :docker
  @moduletag :vm

  # Building the kernel takes a while.
  @moduletag timeout: to_timeout(hour: 1)

  # The artifacts mix sandbox.setup built, or new ones. Firecracker must be on
  # the PATH, and /dev/kvm usable.
  setup_all do
    dir = Path.expand("../../priv/sandbox", __DIR__)

    unless File.exists?(Path.join(dir, "manifest.json")) do
      {:ok, _kernel} = Builder.build_kernel(output_dir: dir)
      {:ok, _rootfs} = Builder.build_rootfs(output_dir: dir)
      {:ok, _netd} = Builder.build_netd(output_dir: dir)
    end

    %{artifacts_dir: dir}
  end

  test "runs a command as an unprivileged user", %{artifacts_dir: artifacts_dir} do
    script = ~S"""
    printf '%s|' "$@"
    echo
    id -u
    pwd
    echo error >&2
    exit 3
    """

    job = %Job{
      command: ["sh", "-c", script, "sh", "it's", "$HOME", "a b"],
      working_directory: "/workspace/project"
    }

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    assert result.status == :exited
    assert result.exit_status == 3
    assert result.stdout == "it's|$HOME|a b|\n1000\n/workspace/project\n"
    assert result.stderr == "error\n"
    assert result.output_complete?
  end

  # Output written right before the job exits used to be lost when the VM
  # powered off (but interestingly only for stderr).
  test "returns all output of a job", %{artifacts_dir: artifacts_dir} do
    size = 4_000_000
    script = "head -c #{size} /dev/zero | tr '\\0' o; head -c #{size} /dev/zero | tr '\\0' e >&2"

    assert {:ok, %Result{} = result} =
             Sandbox.run(%Job{command: ["sh", "-c", script]}, artifacts_dir: artifacts_dir)

    assert result.output_complete?
    assert result.stdout == :binary.copy("o", size)
    assert result.stderr == :binary.copy("e", size)
  end

  @tag :tmp_dir
  test "extracts the workspace archive before running the command", %{
    artifacts_dir: artifacts_dir,
    tmp_dir: tmp_dir
  } do
    big = :crypto.strong_rand_bytes(10_000_000)
    archive = Path.join(tmp_dir, "workspace.tar.gz")

    # Archives of a directory usually start with a ./ entry, which tar applies to
    # /workspace itself.
    empty_dir = Path.join(tmp_dir, "empty")
    File.mkdir!(empty_dir)

    :ok =
      :erl_tar.create(
        String.to_charlist(archive),
        [
          {~c".", String.to_charlist(empty_dir)},
          {~c"project/mix.exs", "# mix"},
          {~c"project/big.bin", big},
          {~c"project/deps/dep/lib/dep.ex", "# dep"}
        ],
        [:compressed]
      )

    job = %Job{
      command: ["sh", "-c", "find . -type f | sort; stat -c %u mix.exs; sha256sum big.bin"],
      working_directory: "/workspace/project",
      workspace_archive: archive
    }

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    assert result.status == :exited

    assert result.stdout == """
           ./big.bin
           ./deps/dep/lib/dep.ex
           ./mix.exs
           1000
           #{Base.encode16(:crypto.hash(:sha256, big), case: :lower)}  big.bin
           """
  end

  @tag :tmp_dir
  test "reports a job that fails before its command runs", %{
    artifacts_dir: artifacts_dir,
    tmp_dir: tmp_dir
  } do
    not_a_tar = Path.join(tmp_dir, "not-a.tar")
    File.write!(not_a_tar, "hello")

    job = %Job{command: ["sh", "-c", "echo should not run"], workspace_archive: not_a_tar}

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    assert result.status == :setup_failed
    assert result.exit_status == nil
    assert result.stdout == ""
    assert result.system_log =~ "This does not look like a tar archive"
  end

  test "fails for a missing workspace archive", %{artifacts_dir: artifacts_dir} do
    job = %Job{command: ["true"], workspace_archive: "/missing.tar"}

    assert Sandbox.run(job, artifacts_dir: artifacts_dir) ==
             {:error, {:workspace_archive, :enoent}}
  end

  # In the guest, "localhost" is the guest itself, but "localhost." is looked up
  # through the sandbox's DNS and so reaches the host.
  test "relays connections of a job with a mediated network", %{artifacts_dir: artifacts_dir} do
    port = http_server("hello from the host")

    job = %Job{
      command: ["bash", "-c", http_get(), "bash", "localhost.", "#{port}"],
      network: :mediated,
      allowed_hosts: ["localhost"]
    }

    assert {:ok, %Result{} = result} =
             Sandbox.run(job, artifacts_dir: artifacts_dir, allow_reserved_destinations: true)

    assert result.stdout =~ "hello from the host"

    assert [%Connection{host: "localhost", port: ^port, tls?: false, error: nil} = connection] =
             result.connections

    assert connection.sent > 0
    assert connection.received > 0
  end

  test "refuses connections to hosts that aren't allowed", %{artifacts_dir: artifacts_dir} do
    port = http_server("not for you")

    job = %Job{
      command: ["bash", "-c", http_get(), "bash", "localhost.", "#{port}"],
      network: :mediated,
      allowed_hosts: ["hex.pm"]
    }

    assert {:ok, %Result{} = result} =
             Sandbox.run(job, artifacts_dir: artifacts_dir, allow_reserved_destinations: true)

    refute result.stdout =~ "not for you"
    assert [%Connection{host: "localhost", error: :not_allowed}] = result.connections
  end

  test "records the server name a TLS client asked for", %{artifacts_dir: artifacts_dir} do
    port = http_server("not TLS")

    script = """
    ssl:start(),
    ssl:connect("localhost.", #{port}, [{verify, verify_none}, {server_name_indication, "hex.pm"}]),
    halt().
    """

    job = %Job{
      command: ["erl", "-noshell", "-eval", script],
      network: :mediated,
      allowed_hosts: ["localhost", "hex.pm"]
    }

    assert {:ok, %Result{} = result} =
             Sandbox.run(job, artifacts_dir: artifacts_dir, allow_reserved_destinations: true)

    assert [%Connection{host: "localhost", tls?: true, server_name: "hex.pm"}] =
             result.connections
  end

  test "denies connections to addresses that aren't public", %{artifacts_dir: artifacts_dir} do
    port = http_server("unreachable")

    job = %Job{
      command: ["bash", "-c", http_get(), "bash", "localhost.", "#{port}"],
      network: :mediated,
      allowed_hosts: ["localhost"]
    }

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    refute result.stdout =~ "unreachable"
    assert [%Connection{host: "localhost", error: :reserved_address}] = result.connections
  end

  test "reports each name a job looked up once", %{artifacts_dir: artifacts_dir} do
    job = %Job{
      command: ["sh", "-c", "getent ahosts google.com; getent hosts Google.com."],
      network: :mediated
    }

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    assert result.stdout =~ "10.99.0.1"
    assert result.lookups == ["google.com"]
  end

  test "reports lookups and UDP datagrams that went nowhere", %{artifacts_dir: artifacts_dir} do
    job = %Job{command: ["bash", "-c", "echo > /dev/udp/hex.pm/123"], network: :mediated}

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    assert result.lookups == ["hex.pm"]
    assert result.blocked == [%Blocked{protocol: :udp, host: "hex.pm", port: 123}]
  end

  @tag :tmp_dir
  test "reports a VM that stops without an exit status as crashed", %{
    artifacts_dir: artifacts_dir,
    tmp_dir: broken_dir
  } do
    for file <- File.ls!(artifacts_dir), file != "manifest.json" do
      File.ln_s!(Path.join(artifacts_dir, file), Path.join(broken_dir, file))
    end

    unknown_uuid = "00000000-0000-0000-0000-000000000000"
    File.write!(Path.join(broken_dir, "manifest.json"), ~s({"partition_uuid": "#{unknown_uuid}"}))

    assert {:ok, %Result{} = result} =
             Sandbox.run(%Job{command: ["true"]}, artifacts_dir: broken_dir)

    assert result.status == :crashed
    assert result.exit_status == nil
    refute result.output_complete?
    assert result.system_log =~ "Unable to mount root fs"
  end

  test "kills a job that runs longer than its timeout", %{artifacts_dir: artifacts_dir} do
    job = %Job{command: ["sleep", "60"], timeout: 1_000}

    assert {:ok, %Result{} = result} = Sandbox.run(job, artifacts_dir: artifacts_dir)
    assert result.status == :timeout
    assert result.exit_status == nil
    refute result.output_complete?
  end

  test "stops the VM when its owner exits", %{artifacts_dir: artifacts_dir} do
    owner = spawn(fn -> Process.sleep(:infinity) end)
    {vm, os_pid} = start_vm(owner, artifacts_dir)

    Process.exit(owner, :kill)

    assert_receive {:DOWN, _ref, :process, ^vm, :normal}, 1_000
    assert_os_process_exits(os_pid)
  end

  test "stops the VM when the supervisor shuts it down", %{artifacts_dir: artifacts_dir} do
    {vm, os_pid} = start_vm(self(), artifacts_dir)

    :ok = DynamicSupervisor.terminate_child(Playground.Sandbox.Supervisor, vm)

    assert_receive {:DOWN, _ref, :process, ^vm, :shutdown}, 1_000
    assert_os_process_exits(os_pid)
  end

  defp http_get do
    ~S"""
    exec 3<>"/dev/tcp/$1/$2"
    printf 'GET / HTTP/1.0\r\n\r\n' >&3
    cat <&3
    """
  end

  defp http_server(body) do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}, active: false])
    {:ok, port} = :inet.port(listener)

    start_supervised!(
      {Task,
       fn ->
         {:ok, socket} = :gen_tcp.accept(listener)
         {:ok, _request} = :gen_tcp.recv(socket, 0)
         :gen_tcp.send(socket, "HTTP/1.0 200 OK\r\n\r\n" <> body)
         :gen_tcp.close(socket)
       end}
    )

    port
  end

  defp start_vm(owner, artifacts_dir) do
    job = %Job{command: ["sleep", "60"]}

    {:ok, vm} =
      DynamicSupervisor.start_child(
        Playground.Sandbox.Supervisor,
        {VM, {backend(), job, owner, [artifacts_dir: artifacts_dir]}}
      )

    Process.monitor(vm)
    {vm, :sys.get_state(vm).os_pid}
  end

  defp backend, do: Firecracker

  # A killed process lingers until its parent reaps it.
  defp assert_os_process_exits(os_pid, attempts \\ 100) do
    case System.cmd("kill", ["-0", Integer.to_string(os_pid)], stderr_to_stdout: true) do
      {_output, 0} when attempts > 0 ->
        Process.sleep(10)
        assert_os_process_exits(os_pid, attempts - 1)

      {_output, status} ->
        assert status != 0, "OS process #{os_pid} is still running"
    end
  end
end
