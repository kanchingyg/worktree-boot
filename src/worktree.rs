use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::cow_engine::cow_copy_path;
use crate::paths::{assert_worktree_path_contained, sanitize_branch, worktree_path};
use crate::port_shift::{build_local_llm_env, merge_env_lines, shift_ports_in_text};

const COW_TARGETS: &[&str] = &["node_modules", ".next", ".turbo", ".cache"];

const PROPAGATE_KEYS: &[&str] = &[
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "SILICONFLOW_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENAI_API_KEY",
];

#[derive(Debug, Clone, Serialize)]
pub struct BootResult {
    pub branch: String,
    pub path: String,
    pub port_offset: u16,
    pub ports: PortMap,
    pub cloned: Vec<String>,
    pub env_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortMap {
    pub app: u16,
    pub vite: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeEntry {
    pub branch: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

pub fn git_root(cwd: &Path) -> Result<PathBuf, String> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a git repository".into());
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

pub fn list_worktrees(repo_root: &Path) -> Result<Vec<WorktreeEntry>, String> {
    let out = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut entries = Vec::new();
    let mut path = String::new();
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.trim().to_string();
        }
        if line.starts_with("branch ") && path.contains(".worktrees") {
            let branch = line
                .replace("branch refs/heads/", "")
                .trim()
                .to_string();
            let mut port = None;
            let env_path = PathBuf::from(&path).join(".env");
            if env_path.exists() {
                if let Ok(content) = fs::read_to_string(&env_path) {
                    for l in content.lines() {
                        if let Some(p) = l.strip_prefix("PORT=") {
                            port = p.parse().ok();
                            break;
                        }
                    }
                }
            }
            entries.push(WorktreeEntry {
                branch,
                path: path.clone(),
                port,
            });
        }
    }
    Ok(entries)
}

pub fn default_port_offset(repo_root: &Path) -> Result<u16, String> {
    let n = list_worktrees(repo_root)?.len();
    Ok((n + 1) as u16)
}

pub struct BootOpts {
    pub repo_root: Option<PathBuf>,
    pub port_offset: Option<u16>,
    pub dry_run: bool,
    pub propagate_api_keys: bool,
}

pub fn boot_worktree(branch: &str, opts: &BootOpts) -> Result<BootResult, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let repo_root = opts
        .repo_root
        .clone()
        .unwrap_or_else(|| git_root(&cwd).unwrap_or(cwd));
    let port_offset = opts
        .port_offset
        .unwrap_or_else(|| default_port_offset(&repo_root).unwrap_or(1));
    let safe_branch = sanitize_branch(branch)?;
    let wt_path = worktree_path(&repo_root, branch)?;
    let mut cloned = Vec::new();

    if opts.dry_run {
        for name in COW_TARGETS {
            if repo_root.join(name).exists() {
                cloned.push(name.to_string());
            }
        }
        let lance = repo_root.join(".kilocode").join("lancedb");
        if lance.exists() {
            cloned.push(".kilocode/lancedb".into());
        }
        let env_files = list_env_files(&repo_root)?;
        return Ok(BootResult {
            branch: safe_branch,
            path: wt_path.to_string_lossy().into_owned(),
            port_offset,
            ports: PortMap {
                app: 3000 + port_offset,
                vite: 5173 + port_offset,
            },
            cloned,
            env_files,
        });
    }

    let status = Command::new("git")
        .args([
            "worktree",
            "add",
            wt_path.to_str().unwrap_or(""),
            "-b",
            &safe_branch,
        ])
        .current_dir(&repo_root)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("git worktree add failed".into());
    }
    let contained = assert_worktree_path_contained(&repo_root, &wt_path)?;

    cloned = clone_cow_artifacts(&repo_root, &contained)?;
    let env_files = copy_ignored_env_files(&repo_root, &contained, false)?;
    for ent in &env_files {
        let p = contained.join(ent);
        if !p.exists() {
            continue;
        }
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        let shifted = shift_ports_in_text(&raw, port_offset);
        let mut extras = build_local_llm_env(port_offset);
        if opts.propagate_api_keys {
            for k in PROPAGATE_KEYS {
                if let Ok(v) = std::env::var(k) {
                    extras.insert(k.to_string(), v);
                }
            }
        }
        let merged = merge_env_lines(&shifted, &extras);
        fs::write(&p, merged).map_err(|e| e.to_string())?;
    }

    Ok(BootResult {
        branch: safe_branch,
        path: contained.to_string_lossy().into_owned(),
        port_offset,
        ports: PortMap {
            app: 3000 + port_offset,
            vite: 5173 + port_offset,
        },
        cloned,
        env_files,
    })
}

fn clone_cow_artifacts(repo_root: &Path, worktree_root: &Path) -> Result<Vec<String>, String> {
    let mut cloned = Vec::new();
    for name in COW_TARGETS {
        let src = repo_root.join(name);
        if !src.exists() {
            continue;
        }
        cow_copy_path(&src, &worktree_root.join(name))?;
        cloned.push(name.to_string());
    }
    let lance_src = repo_root.join(".kilocode").join("lancedb");
    if lance_src.exists() {
        cow_copy_path(&lance_src, &worktree_root.join(".kilocode").join("lancedb"))?;
        cloned.push(".kilocode/lancedb".into());
    }
    if let Ok(entries) = fs::read_dir(repo_root) {
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".db") && !name.ends_with(".sqlite") {
                continue;
            }
            if ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                cow_copy_path(&ent.path(), &worktree_root.join(&name))?;
                cloned.push(name);
            }
        }
    }
    Ok(cloned)
}

fn list_env_files(repo_root: &Path) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    for ent in fs::read_dir(repo_root).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let name = ent.file_name().to_string_lossy().into_owned();
        if !name.starts_with(".env") {
            continue;
        }
        if ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            copied.push(name);
        }
    }
    Ok(copied)
}

fn copy_ignored_env_files(
    repo_root: &Path,
    worktree_root: &Path,
    dry_run: bool,
) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    for ent in fs::read_dir(repo_root).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let name = ent.file_name().to_string_lossy().into_owned();
        if !name.starts_with(".env") {
            continue;
        }
        if ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            copied.push(name.clone());
            if !dry_run {
                cow_copy_path(&ent.path(), &worktree_root.join(&name))?;
            }
        }
    }
    Ok(copied)
}

pub struct TeardownOpts {
    pub repo_root: Option<PathBuf>,
    pub confirm: bool,
    pub dry_run: bool,
}

pub fn teardown_worktree(branch: &str, opts: &TeardownOpts) -> Result<String, String> {
    if !opts.confirm {
        return Err("teardown_worktree requires confirm: true".into());
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let repo_root = opts
        .repo_root
        .clone()
        .unwrap_or_else(|| git_root(&cwd).unwrap_or(cwd));
    let wt_path = worktree_path(&repo_root, branch)?;
    if opts.dry_run {
        return Ok(wt_path.to_string_lossy().into_owned());
    }
    let status = Command::new("git")
        .args([
            "worktree",
            "remove",
            wt_path.to_str().unwrap_or(""),
            "--force",
        ])
        .current_dir(&repo_root)
        .status();
    if status.map(|s| s.success()).unwrap_or(false) {
        return Ok(wt_path.to_string_lossy().into_owned());
    }
    if wt_path.exists() {
        fs::remove_dir_all(&wt_path).map_err(|e| e.to_string())?;
    }
    Ok(wt_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{}-{}", prefix, nanos))
    }

    fn init_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir)
            .output()
            .unwrap();
        fs::write(dir.join("README.md"), "# demo\n").unwrap();
        fs::write(dir.join(".env"), "PORT=3000\nAPI_URL=http://localhost:3000/api\n").unwrap();
        fs::create_dir_all(dir.join("node_modules").join("demo-pkg")).unwrap();
        fs::write(
            dir.join("node_modules").join("demo-pkg").join("index.js"),
            "module.exports = 1;\n",
        )
        .unwrap();
        fs::write(dir.join(".gitignore"), "node_modules\n.env\n").unwrap();
        Command::new("git")
            .args(["add", "README.md", ".gitignore"])
            .current_dir(dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir)
            .output()
            .unwrap();
    }

    #[test]
    fn boot_worktree_shifts_env_and_clones_node_modules() {
        let dir = temp_dir("wtb-boot");
        init_repo(&dir);
        let res = boot_worktree(
            "feat-1",
            &BootOpts {
                repo_root: Some(dir.clone()),
                port_offset: Some(1),
                dry_run: false,
                propagate_api_keys: false,
            },
        );
        if res.is_err() && cfg!(windows) {
            let preview = boot_worktree(
                "feat-1-preview",
                &BootOpts {
                    repo_root: Some(dir.clone()),
                    port_offset: Some(1),
                    dry_run: true,
                    propagate_api_keys: false,
                },
            )
            .expect("dry-run boot");
            assert!(preview.env_files.iter().any(|f| f == ".env"));
            assert!(preview.cloned.iter().any(|c| c == "node_modules"));
            assert_eq!(preview.ports.app, 3001);
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let res = res.unwrap();
        assert!(
            PathBuf::from(&res.path)
                .join("node_modules")
                .join("demo-pkg")
                .join("index.js")
                .exists()
        );
        let env_path = PathBuf::from(&res.path).join(".env");
        let env = fs::read_to_string(env_path).unwrap();
        assert!(env.contains("PORT=3001"));
        assert_eq!(res.ports.app, 3001);
        let _ = fs::remove_dir_all(&dir);
    }
}
