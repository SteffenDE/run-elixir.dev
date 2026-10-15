defmodule Playground.Sandbox.BuilderTest do
  use ExUnit.Case, async: true

  alias Playground.Sandbox.Builder

  test "returns the status of a failed build" do
    cmd = fn _command, _args, _opts -> {"", 17} end

    assert Builder.build_kernel(cmd: cmd) == {:error, {:docker, 17}}
  end

  describe "build_kernel/1" do
    @tag :tmp_dir
    test "installs the kernel and its config", %{tmp_dir: output_dir} do
      cmd = fn "docker", args, _opts ->
        # a stage of the project's Dockerfile
        assert ["buildx", "build", "--platform", "linux/arm64" | _rest] = args
        assert option(args, "--target") == "sandbox-kernel"
        assert File.regular?(option(args, "--file"))
        assert File.dir?(Path.join(List.last(args), "sandbox"))

        destination = export_destination(args)
        File.write!(Path.join(destination, "kernel"), "kernel")
        File.write!(Path.join(destination, "kernel.config"), "CONFIG_EXT4_FS=y")
        {"", 0}
      end

      assert {:ok, kernel} =
               Builder.build_kernel(platform: "linux/arm64", output_dir: output_dir, cmd: cmd)

      assert File.read!(kernel) == "kernel"
      assert Enum.sort(File.ls!(output_dir)) == ["kernel", "kernel.config"]
    end
  end

  describe "build_rootfs/1" do
    @tag :tmp_dir
    test "installs the disk and its manifest", %{tmp_dir: output_dir} do
      cmd = fn "docker", args, _opts ->
        assert option(args, "--target") == "sandbox-rootfs"
        destination = export_destination(args)
        File.write!(Path.join(destination, "rootfs.raw"), "disk")
        File.write!(Path.join(destination, "manifest.json"), "{}")
        {"", 0}
      end

      assert {:ok, rootfs} = Builder.build_rootfs(output_dir: output_dir, cmd: cmd)
      assert File.read!(rootfs) == "disk"
      assert Enum.sort(File.ls!(output_dir)) == ["manifest.json", "rootfs.raw"]
    end
  end

  describe "build_netd/1" do
    @tag :tmp_dir
    test "installs sandbox-netd built for this machine", %{tmp_dir: output_dir} do
      cmd = fn "docker", args, _opts ->
        assert Enum.any?(args, &String.starts_with?(&1, "TARGET_OS="))
        assert Enum.any?(args, &String.starts_with?(&1, "TARGET_ARCH="))
        File.write!(Path.join(export_destination(args), "sandbox-netd"), "binary")
        {"", 0}
      end

      assert {:ok, netd} = Builder.build_netd(output_dir: output_dir, cmd: cmd)
      assert File.read!(netd) == "binary"
      assert File.ls!(output_dir) == ["sandbox-netd"]
    end
  end

  defp export_destination(args) do
    "type=local,dest=" <> destination = option(args, "--output")
    destination
  end

  defp option(args, name) do
    Enum.at(args, Enum.find_index(args, &(&1 == name)) + 1)
  end
end
