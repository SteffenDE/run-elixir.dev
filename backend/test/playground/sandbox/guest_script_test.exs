defmodule Playground.Sandbox.GuestScriptTest do
  use ExUnit.Case, async: true

  alias Playground.Sandbox.GuestScript
  alias Playground.Sandbox.Job

  test "quotes every argument for the shell" do
    script = GuestScript.build(%Job{command: ["printf", "%s|", "it's", "$HOME", "a b"]})

    assert script =~ ~S('printf' '%s|' 'it'\''s' '$HOME' 'a b')
  end

  test "marks the job as started right before running the command" do
    script = GuestScript.build(%Job{command: ["true"]})

    assert script =~ ": >/run/job-started\nexec setpriv"
  end

  test "merges the job's environment into the default one" do
    job = %Job{
      command: ["true"],
      working_directory: "/workspace/project",
      environment: %{"MIX_ENV" => "prod", "LANG" => "C"}
    }

    assert GuestScript.build(job) =~
             "env -i -- 'HOME=/workspace/project' 'LANG=C' 'MIX_ENV=prod' " <>
               "'MIX_HOME=/usr/local/lib/mix' " <>
               "'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' 'true'"
  end

  test "extracts the workspace archive as the job user, reading exactly its size" do
    job = %Job{command: ["true"], workspace_archive: "workspace.tar.gz"}
    script = GuestScript.build(job, workspace_archive: %{size: 3264, gzip?: true})

    assert script =~
             "head -c 3264 <&6 | " <>
               "setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs " <>
               "tar -xzf - -C /workspace\n"
  end
end
