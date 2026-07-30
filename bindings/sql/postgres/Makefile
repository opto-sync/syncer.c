EXTENSION = opto_sync
MODULE_big = opto_sync
OBJS = opto_sync_pg.o options_core.o syncer_core.o yyjson_core.o
DATA = opto_sync--0.2.1.sql

PG_CONFIG ?= pg_config
PG_CPPFLAGS = -I$(CURDIR)/../../../core/include \
	-I$(CURDIR)/../../../core/src \
	-I$(CURDIR)/../common
# PostgreSQL warns for declarations after statements to accommodate its C90
# codebase. opto-sync is C99 by contract, including the embedded core.
PG_CFLAGS = -Wno-declaration-after-statement

PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)

.PHONY: test-local
test-local: all
	./test.sh
