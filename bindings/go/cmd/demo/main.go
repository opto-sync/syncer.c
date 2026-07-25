// Command demo shows basic usage of the syncer-go binding.
package main

import (
	"fmt"
	"log"

	syncer "github.com/opto-sync/syncer-go"
)

func main() {
	fmt.Println("syncer.c core version:", syncer.Version())

	base := `{"a": 1, "b": {"c": 2}, "items": [{"id": 1, "qty": 5}]}`
	incoming := `{"b": {"d": 3}, "e": 4, "items": [{"id": 1, "qty": 7}, {"id": 2, "qty": 1}]}`

	merged, err := syncer.MergeJSON(base, incoming)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("Default merge:  ", merged)

	mergedByKey, err := syncer.MergeJSONWithOptions(base, incoming, syncer.Options{
		ArrayStrategy: syncer.ArrayMergeByKey,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("Merge by key:   ", mergedByKey)
}
