CC ?= cc
SQLITE3_CFLAGS ?=
CFLAGS ?= -O2 -Wall -Wextra -Wpedantic

CORE := ../../../core
COMMON := ../common
SOURCES := opto_sync_sqlite.c $(COMMON)/options.c \
	$(CORE)/src/syncer.c $(CORE)/src/yyjson.c
INCLUDES := -I$(CORE)/include -I$(CORE)/src -I$(COMMON) $(SQLITE3_CFLAGS)

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  SHARED_FLAGS := -bundle -undefined dynamic_lookup
  EXT := dylib
else ifeq ($(OS),Windows_NT)
  SHARED_FLAGS := -shared
  EXT := dll
else
  SHARED_FLAGS := -shared
  EXT := so
endif

TARGET := opto_sync.$(EXT)

.PHONY: all test clean

all: $(TARGET)

$(TARGET): $(SOURCES) $(COMMON)/options.h $(CORE)/include/syncer.h
	$(CC) $(CFLAGS) -fPIC $(SHARED_FLAGS) $(INCLUDES) -o $@ $(SOURCES)

test: $(TARGET)
	./test.sh ./$(TARGET)

clean:
	rm -f opto_sync.so opto_sync.dylib opto_sync.dll
