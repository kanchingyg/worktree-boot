use std::path::{Component, Path, PathBuf};

pub fn sanitize_branch(branch: &str) -> Result<String, String> {
    if branch.is_empty() || branch == "." || branch == ".." {
        return Err("Invalid branch name".into());
    }
    if branch.contains("..") || branch.contains('/') || branch.contains('\\') {
        return Err("Invalid branch name: path traversal characters not allowed".into());
    }
    let sanitized: String = branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err("Invalid branch name".into());
    }
    Ok(sanitized)
}

pub fn worktrees_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".worktrees")
}

pub fn worktree_path(repo_root: &Path, branch: &str) -> Result<PathBuf, String> {
    let safe = sanitize_branch(branch)?;
    let base = worktrees_root(repo_root);
    let wt_path = base.join(&safe);
    let rel = path_relative(&base, &wt_path);
    if rel
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Worktree path escapes .worktrees directory".into());
    }
    Ok(wt_path)
}

pub fn assert_worktree_path_contained(repo_root: &Path, wt_path: &Path) -> Result<PathBuf, String> {
    let base = worktrees_root(repo_root);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let real_base = std::fs::canonicalize(&base).unwrap_or(base);
    let candidate = wt_path
        .canonicalize()
        .unwrap_or_else(|_| wt_path.to_path_buf());
    let rel = path_relative(&real_base, &candidate);
    if rel
        .components()
        .any(|c| matches!(c, Component::ParentDir))
        || rel.as_os_str().is_empty()
    {
        return Err("Worktree path escapes .worktrees directory".into());
    }
    Ok(candidate)
}

fn path_relative(base: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut it_base = base.components().peekable();
    let mut it_path = path.components().peekable();
    while it_base.peek() == it_path.peek() {
        if it_base.peek().is_none() {
            break;
        }
        it_base.next();
        it_path.next();
    }
    for _ in it_base {
        out.push(Component::ParentDir);
    }
    for c in it_path {
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_branch_names() {
        assert!(sanitize_branch("../../../evil").is_err());
        assert!(sanitize_branch("..").is_err());
        assert!(sanitize_branch("feat/evil").is_err());
    }

    #[test]
    fn sanitizes_safe_branch() {
        assert_eq!(sanitize_branch("feat-1").unwrap(), "feat-1");
    }
}
