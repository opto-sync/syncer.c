module github.com/opto-sync/syncer-gorm

go 1.21

require (
	github.com/opto-sync/syncer-go v0.0.0
	gorm.io/gorm v1.25.12
)

replace github.com/opto-sync/syncer-go => ../../../bindings/go
