use krites_fixture::{total, SEED};

#[test]
fn total_sums_the_values() {
    assert_eq!(total(&[SEED, 2, 3]), SEED + 5);
}
