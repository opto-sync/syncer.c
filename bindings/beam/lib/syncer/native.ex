defmodule Syncer.Native do
  @moduledoc """
  Raw Rustler NIF bindings. Not part of the public API — use `Syncer` instead.

  `merge/3` expects an already-normalized option map (see
  `Syncer.normalize_options/1`); passing anything else raises `ArgumentError`
  from the decoder.
  """

  use Rustler, otp_app: :opto_sync_nif, crate: "syncer_nif"

  @doc false
  @spec merge(binary(), binary(), map()) :: {:ok, binary()} | {:error, :merge_failed}
  def merge(_base, _incoming, _opts), do: :erlang.nif_error(:nif_not_loaded)

  @doc false
  @spec version() :: binary()
  def version, do: :erlang.nif_error(:nif_not_loaded)
end
