defmodule Playground.Nif.RecipeTest do
  use ExUnit.Case, async: true

  alias Playground.Nif.Recipe

  test "takes a script, permitted hosts and a timeout" do
    assert {:ok, %Recipe{script: "make", allowed_hosts: [], timeout_minutes: 10}} =
             Recipe.new(%{"script" => "make"})

    assert {:ok, recipe} =
             Recipe.new(%{
               "script" => "make",
               "allowed_hosts" => ["codeload.github.com", "repo.hex.pm"],
               "timeout_minutes" => 30
             })

    assert Recipe.dump(recipe) == %{
             "script" => "make",
             "allowed_hosts" => ["codeload.github.com", "repo.hex.pm"],
             "timeout_minutes" => 30
           }
  end

  test "refuses hosts the backend does not permit, and other mistakes" do
    assert {:error, "hosts not permitted: example.com"} =
             Recipe.new(%{"script" => "make", "allowed_hosts" => ["example.com"]})

    assert {:error, "hosts not permitted: *.com"} =
             Recipe.new(%{"script" => "make", "allowed_hosts" => ["*.com"]})

    assert {:error, "script must be" <> _} = Recipe.new(%{"script" => ""})

    assert {:error, "timeout_minutes must be 1 to 30"} =
             Recipe.new(%{"script" => "make", "timeout_minutes" => 31})

    assert {:error, "unknown keys: deps"} = Recipe.new(%{"script" => "make", "deps" => []})
  end
end
