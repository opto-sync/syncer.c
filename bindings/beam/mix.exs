defmodule OptoSyncNif.MixProject do
  use Mix.Project

  @version "0.2.0"

  def project do
    [
      app: :opto_sync_nif,
      version: @version,
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      description:
        "BEAM (Erlang/Elixir/Gleam) bindings for the syncer.c deep JSON merge engine, " <>
          "via a Rustler NIF over the syncer-rs crate.",
      docs: [main: "Syncer", extras: ["README.md"]]
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      {:rustler, "~> 0.36"},
      # Test-only: lets assertions compare decoded documents instead of
      # pattern-matching serialized text. The library itself never decodes JSON.
      {:jason, "~> 1.4", only: :test},
      {:ex_doc, "~> 0.34", only: :dev, runtime: false}
    ]
  end
end
