defmodule Playground.Nif.AgentTest do
  use ExUnit.Case, async: true

  import Playground.AgentFixtures

  alias Playground.Nif.{Agent, Recipe, Tree}

  setup {Req.Test, :verify_on_exit!}

  @tree %Tree{
    name: "demo_nif",
    version: "1.0.0",
    files: %{
      "mix.exs" => ~s(defmodule Demo.MixProject do\n  # make_targets: ["all"]\nend\n),
      "Makefile" => "all:\n\t$(CC) -o $(MIX_APP_PATH)/priv/demo.so c_src/demo.c\n",
      "c_src/demo.c" => "#include <erl_nif.h>\n"
    },
    metadata: %{"app" => "demo_nif", "build_tools" => ["mix", "make"], "requirements" => []}
  }

  test "tries builds until one succeeds, then saves its recipe" do
    expect_replies([
      [calls: [{"read_file", %{"path" => "Makefile", "offset" => 0, "length" => 1000}}]],
      [calls: [{"try_build", build_args("make all")}]],
      [calls: [{"save_template", %{"requirement" => nil, "notes" => "too early"}}]],
      [calls: [{"try_build", build_args("CFLAGS=-DWASI make all")}]],
      [calls: [{"save_template", %{"requirement" => ">= 1.0.0", "notes" => "Needs -DWASI."}}]]
    ])

    assert {:ok, outcome} = run()
    assert %Recipe{script: "CFLAGS=-DWASI make all"} = outcome.recipe
    assert outcome.requirement == ">= 1.0.0"
    assert outcome.notes == "Needs -DWASI."
    assert outcome.build.files == [{"priv/demo.so", 8}]

    # The user prompt has the files and the build files' contents.
    assert_received {:ai_request,
                     %{"input" => input, "tool_choice" => "required", "store" => false}}

    assert Jason.encode!(input) =~ "c_src/demo.c (21 bytes)"
    assert Jason.encode!(input) =~ "$(CC) -o $(MIX_APP_PATH)/priv/demo.so"

    answers = tool_answers()
    assert Enum.at(answers, 0)["content"] =~ "$(CC)"
    assert Enum.at(answers, 1)["content"] =~ ~s("succeeded":false)
    assert Enum.at(answers, 1)["content"] =~ "demo.c:1: error"
    assert Enum.at(answers, 2)["content"] =~ "no try_build has succeeded yet"
    assert Enum.at(answers, 3)["content"] =~ ~s("succeeded":true)
  end

  test "gives up, saying whether the package can't be built at all" do
    expect_replies([
      [calls: [{"give_up", %{"reason" => "No native code.", "unsupported" => true}}]]
    ])

    assert run() == {:unsupported, "No native code."}
  end

  test "refuses recipes with hosts the backend does not permit" do
    expect_replies([
      [calls: [{"try_build", %{build_args("make") | "allowed_hosts" => ["example.com"]}}]],
      [calls: [{"give_up", %{"reason" => "Stuck.", "unsupported" => false}}]]
    ])

    assert run() == {:failed, {:gave_up, "Stuck."}}
    assert hd(tool_answers())["content"] =~ "hosts not permitted: example.com"
  end

  test "insists on a tool call once, then fails" do
    expect_replies([[text: "I think it builds."], [text: "Really."]])

    assert run() == {:failed, :no_tool_call}
  end

  defp run do
    test = self()
    record = fn message, usage -> send(test, {:recorded, message, usage}) end
    Agent.run("demo_nif", "1.0.0", nil, record, tree: @tree, runner: &runner/4)
  end

  defp build_args(script),
    do: %{"script" => script, "allowed_hosts" => [], "timeout_minutes" => 5}

  # Builds with -DWASI only.
  defp runner("demo_nif", "1.0.0", %Recipe{script: script}, _opts) do
    if script =~ "-DWASI" do
      {:ok, %{app: "demo_nif", tar: "tar", files: [{"priv/demo.so", 8}], log: "", duration_ms: 1}}
    else
      {:error,
       %{reason: "the build exited with status 2", log: "demo.c:1: error", duration_ms: 1}}
    end
  end

  defp tool_answers do
    for {:recorded, %{"role" => "tool"} = message, _usage} <- messages(), do: message
  end

  defp messages do
    receive do
      {:recorded, _, _} = message -> [message | messages()]
    after
      0 -> []
    end
  end
end
