defmodule OptoSyncAsh.MixProject do
  use Mix.Project

  def project do
    [
      app: :opto_sync_ash,
      version: "0.2.1",
      elixir: "~> 1.14",
      deps: deps()
    ]
  end

  def application, do: [extra_applications: [:logger]]

  defp deps do
    [
      {:ash, "~> 3.0"},
      {:jason, "~> 1.4"},
      {:opto_sync_nif, path: "../../../bindings/beam"}
    ]
  end
end
