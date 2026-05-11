// Strip git's hook-injected environment variables before any test code runs.
//
// When `pnpm test` is invoked from a pre-commit hook, the parent `git commit`
// process exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, GIT_PREFIX, and
// GIT_OBJECT_DIRECTORY into the hook process. These get inherited by every
// `child_process.execFile('git', ...)` call our tests make, which causes
// `git -C <tmpdir> ...` to silently operate against the **project's** .git
// instead of the tmpdir's. That race-locks the project index against the
// parent `git commit` and produces "invalid object" / "index.lock.lock"
// errors that look like flakes.
//
// Unsetting these vars at the top of vitest's lifecycle restores normal
// repo discovery: each subprocess walks up from its cwd (set via `-C`) to
// find the .git directory of the tmpdir.
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) {
	delete process.env[key]
}
