defmodule Playground.AgentFixtures do
  @moduledoc """
  Replies of the OpenAI Responses API for `Playground.Nif.Agent`, which the
  tests' Req plug serves (after SCA's `SCA.AIFixtures`).
  """

  @doc """
  Queues replies, in order. Each is a keyword list: `:calls`, tool calls as
  `{name, arguments}`, and `:text`. Every request is sent to the calling
  process as `{:ai_request, body}`.
  """
  def expect_replies(replies) do
    test = self()

    for reply <- replies do
      Req.Test.expect(Playground.Nif.Agent, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(test, {:ai_request, Jason.decode!(body)})
        Req.Test.json(conn, response(reply))
      end)
    end

    :ok
  end

  defp response(reply) do
    text =
      for text <- List.wrap(reply[:text]) do
        %{
          "type" => "message",
          "id" => "msg_#{unique()}",
          "role" => "assistant",
          "status" => "completed",
          "content" => [%{"type" => "output_text", "text" => text, "annotations" => []}]
        }
      end

    calls =
      for {name, args} <- reply[:calls] || [] do
        %{
          "type" => "function_call",
          "id" => "fc_#{unique()}",
          "call_id" => "call_#{unique()}",
          "name" => name,
          "arguments" => Jason.encode!(args),
          "status" => "completed"
        }
      end

    %{
      "id" => "resp_#{unique()}",
      "object" => "response",
      "model" => "gpt-6-luna-2026-09-01",
      "status" => "completed",
      "output" => text ++ calls,
      "usage" => %{
        "input_tokens" => 10_000,
        "input_tokens_details" => %{"cached_tokens" => 2_000},
        "output_tokens" => 1_000,
        "output_tokens_details" => %{"reasoning_tokens" => 500},
        "total_tokens" => 11_000
      }
    }
  end

  defp unique, do: System.unique_integer([:positive])
end
