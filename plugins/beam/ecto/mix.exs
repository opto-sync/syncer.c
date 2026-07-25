defmodule OptoSyncEcto.MixProject do
  use Mix.Project

  def project do
    [
      app: :opto_sync_ecto,
      version: "0.2.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps(),
      description:
        "Ecto changeset helpers that reconcile jsonb columns through the opto-sync " <>
          "deep-merge engine instead of overwriting them."
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      {:ecto, "~> 3.10"},
      {:jason, "~> 1.4"},
      {:opto_sync_nif, path: "../../../bindings/beam"},
      # Only used by the Postgres integration test, which is tagged
      # :integration and excluded by default — `mix test` needs no database.
      {:ecto_sql, "~> 3.10", only: [:dev, :test]},
      {:postgrex, "~> 0.17", only: [:dev, :test]}
    ]
  end
end
