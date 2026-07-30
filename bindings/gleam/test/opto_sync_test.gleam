import gleeunit
import gleeunit/should
import opto_sync

pub fn main() {
  gleeunit.main()
}

pub fn version_is_the_native_core_test() {
  opto_sync.version()
  |> should.equal("0.2.1")
}

pub fn deep_merge_runs_through_the_nif_test() {
  opto_sync.merge("{\"a\":1}", "{\"b\":2}")
  |> should.equal(Ok("{\"a\":1,\"b\":2}"))
}

pub fn stale_root_is_rejected_by_canonical_timestamp_policy_test() {
  opto_sync.merge(
    "{\"title\":\"local\",\"updatedAt\":2000,\"nested\":{\"kept\":true}}",
    "{\"title\":\"stale\",\"updatedAt\":1000,\"nested\":{\"lost\":true}}",
  )
  |> should.equal(Ok(
    "{\"title\":\"local\",\"updatedAt\":2000,\"nested\":{\"kept\":true}}",
  ))
}

pub fn keyed_arrays_merge_by_id_test() {
  opto_sync.merge(
    "{\"items\":[{\"id\":\"a\",\"value\":1,\"updatedAt\":1000}]}",
    "{\"items\":[{\"id\":\"a\",\"value\":2,\"updatedAt\":2000},{\"id\":\"b\",\"value\":3}]}",
  )
  |> should.equal(Ok(
    "{\"items\":[{\"id\":\"a\",\"value\":2,\"updatedAt\":2000},{\"id\":\"b\",\"value\":3}]}",
  ))
}

pub fn invalid_json_is_a_typed_error_test() {
  opto_sync.merge("{oops", "{}")
  |> should.equal(Error(opto_sync.MergeFailed))
}

pub fn interior_nul_is_a_typed_error_test() {
  opto_sync.merge("{\"value\":\"\u{0000}\"}", "{}")
  |> should.equal(Error(opto_sync.MergeFailed))
}
