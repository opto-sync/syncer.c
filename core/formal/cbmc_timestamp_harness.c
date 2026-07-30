/*
 * CBMC harness for production C code.
 *
 * Including the implementation keeps the static timestamp comparator identical
 * to the function used by the merge engine; this is not a second model.
 * CBMC symbolically explores every pair of two-digit timestamp strings,
 * including leading-zero representations.
 */
#include "../src/syncer.c"

extern unsigned char nondet_uchar(void);
extern int nondet_int(void);

static unsigned decimal2(const char value[3]) {
    return (unsigned)(value[0] - '0') * 10U +
           (unsigned)(value[1] - '0');
}

int main(void) {
    char left[3];
    char right[3];

    for (size_t i = 0; i < 2; i++) {
        unsigned char left_digit = nondet_uchar();
        unsigned char right_digit = nondet_uchar();
        __CPROVER_assume(left_digit <= 9);
        __CPROVER_assume(right_digit <= 9);
        left[i] = (char)('0' + left_digit);
        right[i] = (char)('0' + right_digit);
    }
    left[2] = '\0';
    right[2] = '\0';

    int comparison = ts_compare(left, right);
    int reverse = ts_compare(right, left);
    unsigned left_value = decimal2(left);
    unsigned right_value = decimal2(right);

    __CPROVER_assert(
        (comparison < 0) == (left_value < right_value),
        "digit timestamps preserve numeric less-than");
    __CPROVER_assert(
        (comparison == 0) == (left_value == right_value),
        "digit timestamps preserve numeric equality");
    __CPROVER_assert(
        (comparison > 0) == (left_value > right_value),
        "digit timestamps preserve numeric greater-than");
    __CPROVER_assert(
        ((comparison > 0) - (comparison < 0)) ==
            -((reverse > 0) - (reverse < 0)),
        "timestamp comparison is antisymmetric");

    syncer_merge_options_t options = syncer_default_options();
    int invalid_strategy = nondet_int();
    __CPROVER_assume(
        invalid_strategy < 0 ||
        invalid_strategy > (int)SYNCER_ARRAY_MERGE_BY_KEY);
    options.array_strategy = (syncer_array_strategy_t)invalid_strategy;
    __CPROVER_assert(
        !array_strategy_is_valid(options.array_strategy),
        "every invalid FFI array strategy is rejected by the production guard");

    return 0;
}
