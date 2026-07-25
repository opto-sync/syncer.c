CC      ?= cc
CFLAGS  := -Wall -Wextra -O2 -Iinclude -Isrc
LDFLAGS :=

SRCS_CORE := src/syncer.c src/yyjson.c
SRCS_TEST := test/test_syncer.c
BIN_TEST  := test/test_syncer
BIN_PROP  := test/prop_test

SAN_FLAGS := -fsanitize=address,undefined -O1 -g

.PHONY: all test prop sanitize clean

all: test prop

test: $(BIN_TEST)
	@echo ""
	@echo "Running tests..."
	@./$(BIN_TEST)

prop: $(BIN_PROP)
	@echo ""
	@echo "Running property tests..."
	@./$(BIN_PROP)

# Full suite under ASan+UBSan
sanitize:
	$(CC) -Wall -Wextra $(SAN_FLAGS) -Iinclude -Isrc -o test/test_syncer_asan $(SRCS_TEST) $(SRCS_CORE)
	$(CC) -Wall -Wextra $(SAN_FLAGS) -Iinclude -Isrc -o test/prop_test_asan test/prop_test.c $(SRCS_CORE)
	./test/test_syncer_asan
	./test/prop_test_asan

$(BIN_TEST): $(SRCS_TEST) $(SRCS_CORE)
	@mkdir -p test
	$(CC) $(CFLAGS) -o $@ $(SRCS_TEST) $(SRCS_CORE) $(LDFLAGS)

$(BIN_PROP): test/prop_test.c $(SRCS_CORE)
	@mkdir -p test
	$(CC) $(CFLAGS) -o $@ test/prop_test.c $(SRCS_CORE) $(LDFLAGS)

clean:
	rm -f $(BIN_TEST) $(BIN_PROP) test/test_syncer_asan test/prop_test_asan
