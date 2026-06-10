# Reviewer runs only for Fresh PR feedback

Trowel will keep `needs-revision` as a PR-review state derived from labels and requested-changes reviews, but Work will schedule Reviewer Turns only when the PR has Fresh PR feedback created at or after the current PR branch head commit time. This avoids rerunning agents against stale comments after a fix has been committed, while preserving GitHub review state and letting humans trigger a new Reviewer pass by adding fresh feedback.
