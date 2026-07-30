# syncer-bun

Bun model-hook helper for JSON/JSONB fields. `BeforeUpdate` reconciles a loaded
field with the incoming value and assigns the decoded result back to the model.

Run the load (with `FOR UPDATE`), `BeforeUpdate`, and Bun update inside one
`db.RunInTx` callback. Bun model hooks alone cannot make an earlier read atomic.
