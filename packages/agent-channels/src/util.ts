/**
 * Utilities for safe async operations.
 */

/**
 * Run async operations in parallel with rollback on partial failure.
 *
 * If any operation fails, all successfully-completed results are rolled
 * back using the provided cleanup function before the error is thrown.
 * Cleanup can be sync or async — async cleanups are awaited.
 *
 * @param items Items to process
 * @param operation Async operation for each item
 * @param cleanup Rollback function for successfully-completed results
 * @returns Array of results (one per item, in order)
 */
export async function allOrCleanup<T, R>(
    items: T[],
    operation: (item: T) => Promise<R>,
    cleanup: (result: R) => void | Promise<void>,
): Promise<R[]> {
    const settled = await Promise.allSettled(items.map(operation));

    const successes: R[] = [];
    let firstError: unknown = null;

    for (const result of settled) {
        if (result.status === "fulfilled") {
            successes.push(result.value);
        } else if (!firstError) {
            firstError = result.reason;
        }
    }

    if (firstError) {
        // Roll back all successful results — await async cleanups
        await Promise.allSettled(
            successes.map(async (result) => {
                try {
                    await cleanup(result);
                } catch {
                    // Best effort cleanup — don't mask the original error
                }
            }),
        );
        throw firstError;
    }

    return successes;
}
