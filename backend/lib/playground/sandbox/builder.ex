defmodule Playground.Sandbox.Builder do
  @moduledoc """
  Builds the artifacts a sandbox VM boots from.

  They are stages of the project's Dockerfile, which the release image copies
  too, so the only requirement on the host is a Docker installation with
  Buildx. `DOCKER` names the command (`sudo -n docker`, say).

  In production, the image ships the artifacts, so this module is only
  meant to be used in development and tests.
  """

  alias Playground.Sandbox.Builder.Log

  @project_dir Path.expand("../../..", __DIR__)
  @output_dir Path.join(@project_dir, "priv/sandbox")

  @doc """
  Builds the Linux kernel the VM boots.

  Writes `kernel` and its resolved `kernel.config` to the output directory. On
  x86, it also writes `vmlinux`, the uncompressed kernel Firecracker boots.

  Options:

    * `:platform` - the kernel platform, defaults to Linux on the host architecture
    * `:output_dir` - where the kernel is written, defaults to `priv/sandbox`
    * `:cmd` - the function used to run commands, defaults to `System.cmd/3`

  """
  @spec build_kernel(keyword()) :: {:ok, Path.t()} | {:error, term()}
  def build_kernel(opts \\ []) do
    files = ["kernel", "kernel.config", {:optional, "vmlinux"}]

    with {:ok, output_dir} <- export("sandbox-kernel", [], files, opts) do
      {:ok, Path.join(output_dir, "kernel")}
    end
  end

  @doc """
  Builds the root disk, a raw disk with one ext4 partition holding the guest's
  userspace.

  Writes `rootfs.raw` and a `manifest.json` with the partition's UUID, which the
  kernel mounts as its root, to the output directory.

  Options:

    * `:platform` - the guest platform, defaults to Linux on the host architecture
    * `:output_dir` - where the disk is written, defaults to `priv/sandbox`
    * `:cmd` - the function used to run commands, defaults to `System.cmd/3`

  """
  @spec build_rootfs(keyword()) :: {:ok, Path.t()} | {:error, term()}
  def build_rootfs(opts \\ []) do
    with {:ok, output_dir} <-
           export("sandbox-rootfs", [], ["rootfs.raw", "manifest.json"], opts) do
      {:ok, Path.join(output_dir, "rootfs.raw")}
    end
  end

  @doc """
  Builds `sandbox-netd`, the only network peer of a VM with network access.

  It runs on the host next to the VM, so it's built for the operating system
  and architecture of this machine rather than for the guest.

  Options:

    * `:output_dir` - where the binary is written, defaults to `priv/sandbox`
    * `:cmd` - the function used to run commands, defaults to `System.cmd/3`

  """
  @spec build_netd(keyword()) :: {:ok, Path.t()} | {:error, term()}
  def build_netd(opts \\ []) do
    {:unix, os} = :os.type()
    build_args = ["TARGET_OS=#{os}", "TARGET_ARCH=#{architecture()}"]

    with {:ok, output_dir} <- export("sandbox-netd", build_args, ["sandbox-netd"], opts) do
      {:ok, Path.join(output_dir, "sandbox-netd")}
    end
  end

  # Exports into a temporary directory first, so that files in the output
  # directory are only ever replaced by complete ones. An optional file is one
  # the stage doesn't produce for every platform.
  defp export(target, build_args, files, opts) do
    output_dir = Keyword.get(opts, :output_dir, @output_dir)
    temporary_dir = Path.join(output_dir, ".build-#{System.unique_integer([:positive])}")
    File.mkdir_p!(temporary_dir)

    args =
      ["buildx", "build", "--platform", Keyword.get_lazy(opts, :platform, &default_platform/0)] ++
        Enum.flat_map(build_args, &["--build-arg", &1]) ++
        [
          "--file",
          Path.join(@project_dir, "Dockerfile"),
          "--target",
          target,
          "--output",
          "type=local,dest=#{temporary_dir}",
          @project_dir
        ]

    try do
      with :ok <- docker(args, opts) do
        for file <- files do
          case file do
            {:optional, file} ->
              if File.exists?(Path.join(temporary_dir, file)) do
                File.rename!(Path.join(temporary_dir, file), Path.join(output_dir, file))
              end

            file ->
              File.rename!(Path.join(temporary_dir, file), Path.join(output_dir, file))
          end
        end

        {:ok, output_dir}
      end
    after
      File.rm_rf!(temporary_dir)
    end
  end

  defp docker(args, opts) do
    cmd = Keyword.get(opts, :cmd, &System.cmd/3)

    [docker | prefix] = String.split(System.get_env("DOCKER", "docker"))

    case cmd.(docker, prefix ++ args, into: %Log{}, lines: 1024, stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {_output, status} -> {:error, {:docker, status}}
    end
  end

  defp default_platform, do: "linux/" <> architecture()

  defp architecture do
    architecture = List.to_string(:erlang.system_info(:system_architecture))

    cond do
      String.starts_with?(architecture, ["aarch64", "arm64"]) -> "arm64"
      String.starts_with?(architecture, ["x86_64", "amd64"]) -> "amd64"
      true -> raise "unsupported host architecture: #{architecture}"
    end
  end
end
